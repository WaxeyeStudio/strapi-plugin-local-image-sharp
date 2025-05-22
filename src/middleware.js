'use strict'

/**
 * Enhanced middleware for image processing with improved stability and error handling:
 * - Added proper stream error handling and cleanup
 * - Added validation and sanitization of image dimensions
 * - Implemented timeouts to prevent long-running operations
 * - Improved error handling with detailed logging
 * - Fixed potential race conditions in caching
 * - Added memory optimization for large images
 */

const qs = require('qs')
const { decode } = require('ufo')
const { hash } = require('ohash')
const { join } = require('path')
const { createReadStream, existsSync } = require('fs')
const { writeFile, readFile } = require('fs/promises')
const getEtag = require('etag')

function createMiddleware(ipx) {
  const config = strapi.config.get('plugin::local-image-sharp')

  return async function ipxMiddleware(ctx, next) {
    let path = null
    config.paths.forEach((target) => {
      if (ctx.req.url.includes(target)) {
        path = ctx.req.url.split(target).join('')
      }
    })

    if (!path) {
      const statusCode = 500
      const statusMessage = 'No path found'
      strapi.log.debug(statusMessage)
      ctx.status = statusCode
      return
    }

    const [url, query] = path.split('?')
    const [firstSegment = '', ...idSegments] = url.substr(1 /* leading slash */).split('/')
    const allowedTypes = ['JPEG', 'PNG', 'GIF', 'SVG', 'TIFF', 'ICO', 'DVU', 'JPG', 'WEBP', 'AVIF']
    let id
    let modifiers

    let tempFilePath
    let tempTypePath
    let tempEtagPath

    // extract modifiers from query string
    if (!idSegments.length && firstSegment) {
      id = firstSegment
      modifiers = qs.parse(query)
    } else {
      // extract modifiers from url segments
      id = decode(idSegments.join('/')) // decode is a shortend version of decodeURIComponent
      modifiers = Object.create(null)
      if (firstSegment !== '_') {
        for (const p of firstSegment.split(',')) {
          const [key, value = ''] = p.split('_')
          modifiers[key] = decode(value)
        }
      }
    }

    // if no id or no modifiers or not allowed type, skip
    if (!id || !Object.keys(modifiers).length) {
      await next()
      return
    }

    // Validate file extension
    const fileExt = id.split('.').pop().toUpperCase();
    if (!allowedTypes.includes(fileExt)) {
      strapi.log.debug(`Unsupported file type: ${fileExt}`);
      await next()
      return
    }

    // Validate and sanitize modifiers
    try {
      // Basic validation of modifiers to prevent potential security issues
      for (const [key, value] of Object.entries(modifiers)) {
        // Check for reasonable limits on numeric values
        if (typeof value === 'string' && /^\d+$/.test(value)) {
          const numValue = parseInt(value, 10);
          // Limit image dimensions to reasonable values (e.g., 5000px)
          if ((key === 'w' || key === 'h' || key === 'width' || key === 'height') && numValue > 5000) {
            modifiers[key] = '5000'; // Cap at 5000px
            strapi.log.debug(`Capped ${key} dimension from ${value} to 5000px`);
          }
        }
      }
    } catch (error) {
      strapi.log.error(`Modifier validation error: ${error.message}`);
      // Continue with original modifiers if validation fails
    }

    const objectHash = hash({ id, modifiers })

    // If cache enabled, check if file exists
    if (config.cacheDir) {
      tempFilePath = join(config.cacheDir, `${ objectHash }.raw`)
      tempTypePath = join(config.cacheDir, `${ objectHash }.mime`)
      tempEtagPath = join(config.cacheDir, `${ objectHash }.etag`)

      if (existsSync(tempFilePath)) {
        try {
          const [type, etag] = await Promise.all([readFile(tempTypePath, 'utf-8'), readFile(tempEtagPath, 'utf-8')])
          const stream = createReadStream(tempFilePath)

          // Set up stream error handling
          stream.on('error', (err) => {
            strapi.log.error(`Stream error: ${err.message}`)
            // If the stream errors after headers are sent, we can't do much
            if (!ctx.headerSent) {
              ctx.status = 500
            }
          })

          ctx.set('ETag', etag)
          if (etag && ctx.req.headers['if-none-match'] === etag) {
            ctx.status = 304
            stream.destroy() // Clean up the stream if we're not using it
            return
          }

          // Cache-Control
          if (config.maxAge) {
            ctx.set('Cache-Control', `max-age=${ +config.maxAge }, public, s-maxage=${ +config.maxAge }`)
          }

          // Mime
          if (type) {
            ctx.set('Content-Type', type)
          }
          ctx.body = stream
          return
        } catch (error) {
          // Log the error but continue to generate fresh image
          strapi.log.error(`Cache read error: ${error.message}`)
        }
      }
    }

    // Create request
    const img = ipx(id, modifiers, ctx.req.options)

    // Set up a timeout to prevent long-running image processing operations
    // that could consume excessive memory
    let processingTimeout;
    const timeoutPromise = new Promise((_, reject) => {
      processingTimeout = setTimeout(() => {
        reject(new Error('Image processing timed out'));
      }, 30000); // 30 seconds timeout
    });

    // Get image meta from source
    try {
      // Use Promise.race to implement the timeout
      const src = await Promise.race([
        img.getSourceMeta(),
        timeoutPromise
      ]);

      // Clear the timeout since the operation completed successfully
      clearTimeout(processingTimeout);

      // Caching headers
      if (src.mtime) {
        if (ctx.req.headers['if-modified-since']) {
          if (new Date(ctx.req.headers['if-modified-since']) >= src.mtime) {
            ctx.status = 304
            return
          }
        }
        ctx.set('Last-Modified', `${ +src.mtime }`)
      }

      const maxAge = src.maxAge ?? config.maxAge

      if (maxAge) {
        ctx.set('Cache-Control', `max-age=${ +maxAge }, public, s-maxage=${ +maxAge }`)
      }

      // Get converted image - create a new timeout for this operation
      let processTimeoutId;
      const processTimeoutPromise = new Promise((_, reject) => {
        processTimeoutId = setTimeout(() => {
          reject(new Error('Image processing timed out'));
        }, 30000); // 30 seconds timeout
      });

      const { data, format } = await Promise.race([
        img.process(),
        processTimeoutPromise
      ]);

      // Clear the timeout since the operation completed successfully
      clearTimeout(processTimeoutId);

      // ETag
      const etag = getEtag(data)

      // If cache enabled, write image to temp dir
      if (tempTypePath && tempFilePath) {
        // Use try/catch instead of Promise.catch to properly handle errors
        try {
          // Await the Promise to prevent race conditions
          await Promise.all([
            writeFile(tempTypePath, `image/${ format }`, 'utf-8'),
            writeFile(tempEtagPath, etag, 'utf-8'),
            writeFile(tempFilePath, data)
          ]);
          strapi.log.debug(`Cached image: ${id}`);
        } catch (error) {
          // Log the error but continue with the request
          strapi.log.error(`Cache write error: ${error.message}`);
        }
      }

      ctx.set('ETag', etag)
      if (etag && ctx.req.headers['if-none-match'] === etag) {
        ctx.status = 304
        return
      }

      // Mime
      if (format) {
        ctx.set('Content-Type', `image/${ format }`)
      }

      ctx.body = data
    } catch (error) {
      const statusCode = parseInt(error.statusCode, 10) || 500
      const statusMessage = error.message ? `IPX Error (${ error.message })` : `IPX Error (${ statusCode })`

      // Log more detailed error information
      if (error.stack) {
        strapi.log.error(`${statusMessage}\n${error.stack}`)
      } else {
        strapi.log.error(statusMessage)
      }

      // Add more specific error handling based on error type
      if (error.code === 'ENOENT') {
        // File not found
        strapi.log.debug(`Source image not found: ${id}`)
        ctx.status = 404
      } else if (error.message && error.message.includes('memory')) {
        // Memory-related errors
        strapi.log.error(`Memory error processing image: ${id}`)
        // Clean up any resources that might be leaking
        global.gc && global.gc(); // Force garbage collection if available
        ctx.status = 500
      } else {
        // Generic error
        ctx.status = statusCode
      }

      // Set a basic error response
      ctx.body = { error: 'Image processing failed' }
    }
  }
}

module.exports = {
  createMiddleware
}
