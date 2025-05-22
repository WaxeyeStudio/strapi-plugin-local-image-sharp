import Router from '@koa/router'
import { createIPX, ipxFSStorage } from 'ipx'
import { resolve } from 'node:path'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { createMiddleware } from './middleware.js'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

// Get __dirname equivalent in ES modules
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

export function register({ strapi }) {
  const config = strapi.config.get('plugin::local-image-sharp')
  config.srcDir = strapi.dirs?.static?.public ?? strapi.dirs?.public

  const packageJson = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf8'))
  strapi.log.info(`Using Local Image Sharp plugin v${ packageJson.version }`)
  strapi.log.info(`- Source directory: ${ config.srcDir }`)

  if (config.cacheDir) {
    const cwd = process.cwd()
    config.cacheDir = resolve(cwd, config.cacheDir)

    // prevent cache directory from being in source directory
    if (config.cacheDir.startsWith(config.srcDir)) {
      throw new Error('Cache directory cannot be inside source directory')
    }

    // check if directory exists
    if (!existsSync(config.cacheDir)) {
      mkdirSync(config.cacheDir, { recursive: true })
    }

    strapi.log.info(`- Cache directory: ${ config.cacheDir }`)
  }

  const router = new Router()

  for (const path of config.paths) {
    const ipx = createIPX({
      dir: config.srcDir + path,
      storage: ipxFSStorage({ dir: config.srcDir + path }),
    })

    router.get(`${ path }/(.*)`, createMiddleware(ipx))
  }

  strapi.server.use(router.routes())
}
