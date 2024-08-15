import { createBuilder } from '@yankeeinlondon/builder-api'
import type { Pipeline } from '@yankeeinlondon/builder-api'
import type { Plugin } from 'vite'
import Ajv from 'ajv'
import { md } from './markdown-it'
import fm from 'front-matter'
import fs from 'node:fs'
import path from 'node:path'

const ajv = new Ajv()
const validate = ajv.compile({
  type: 'object',
  additionalProperties: false,
  properties: {
    meta: {
      type: 'object',
      additionalProperties: false,
      properties: {
        nav: { type: 'string' }, // Title used in navigation links
        title: { type: 'string' }, // SEO title
        description: { type: 'string' }, // SEO description
        keywords: { type: 'string' }, // SEO keywords
      },
    },
    layout: { type: 'string' },
    related: {
      type: 'array',
      maxItems: 3,
      uniqueItems: true,
      items: { type: 'string' }, // Absolute paths to related pages
    },
    assets: {
      type: 'array',
      uniqueItems: true,
      items: { type: 'string' }, // Additional stylesheets to load
    },
    disabled: { type: 'boolean' }, // The page is not published
    emphasized: { type: 'boolean' }, // The page is emphasized in the navigation
    fluid: { type: 'boolean' }, // Hide the Toc
    backmatter: { type: 'boolean' }, // Hide the backmatter
    features: {
      type: 'object',
      additionalProperties: false,
      properties: {
        figma: { type: 'boolean' },
        label: { type: 'string' },
        report: { type: 'boolean' },
        github: { type: 'string' },
        spec: { type: 'string' },
      },
    },
  },
})

export const frontmatterBuilder = createBuilder('frontmatterBuilder', 'metaExtracted')
  .options<{
    files?: Map<string, Pipeline<'metaExtracted'>>
    awaiting?: Map<string, ((v: Pipeline<'metaExtracted'>) => void)[]>
    pages?: ReadonlyArray<Record<'name' | 'path' | 'component', string>>
  }>()
  .initializer()
  .handler(async (payload, options) => {
    const { frontmatter, fileName } = payload

    if (!options.pages) {
      const pagesPlugin = payload.viteConfig.plugins!
        .find(p => p && 'name' in p && p.name === 'vite-plugin-pages') as Plugin
      options.pages = await pagesPlugin.api.getResolvedRoutes() as []
    }

    const page = options.pages.find(p => fileName.endsWith(p.component))

    if (!page) throw new Error('Unable to find page')

    const locale = page.path.split('/').at(0)!

    options.files ??= new Map()
    options.files.set(page.path, payload)

    const { meta, ...rest } = frontmatter

    if (locale !== 'en') {
      const originalPath = page.path.replace(`/${locale}/`, '/en/')
      let original = options.files.get(originalPath)
      if (!original) {
        options.awaiting ??= new Map()
        const awaiting = options.awaiting.get(originalPath) ?? []
        const { promise, resolve } = Promise.withResolvers<Pipeline<'metaExtracted'>>()
        awaiting.push(resolve)
        options.awaiting.set(originalPath, awaiting)
        original = await promise
      }
      Object.assign(rest, {
        assets: original.frontmatter.assets,
        related: original.frontmatter.related,
      })
    }

    if (options.awaiting?.has(page.path)) {
      options.awaiting.get(page.path)!.forEach(fn => fn(payload))
    }

    payload.frontmatter = {
      meta,
      assets: rest.assets,
      backmatter: rest.backmatter,
      features: rest.features,
      fluid: rest.fluid,
      related: rest.related,
      toc: generateToc(payload.md),
    }

    return payload
  })
  .meta()

export function getRouteMeta (componentPath: string, locale: string) {
  const str = fs.readFileSync(path.resolve(componentPath.slice(1)), { encoding: 'utf-8' })
  const { attributes } = fm(str)

  const valid = validate(attributes)
  if (!valid && locale !== 'eo-UY') {
    throw new Error(`\nInvalid frontmatter: ${componentPath}` + validate.errors!.map(error => (
      `\n  | Property ${error.instancePath} ${error.message}`
    )).join())
  }

  const a = attributes as any

  if (locale !== 'en') {
    const original = getRouteMeta(componentPath.replace(`/${locale}/`, '/en/'), 'en')
    a.disabled = original.disabled
    a.emphasized = original.emphasized
    a.layout = original.layout
  }

  return {
    disabled: a.disabled,
    emphasized: a.emphasized,
    layout: a.layout,
    ...a.meta,
  }
}

function generateToc (content: string) {
  const headings = []
  const tokens = md.parse(content, {})
  const length = tokens.length

  for (let i = 0; i < length; i++) {
    const token = tokens[i]

    if (token.type === 'inline' && token.content.startsWith('<!--') && !token.content.endsWith('-->')) {
      do {
        i++
      } while (i < length && !tokens[i].content.endsWith('-->'))
      continue
    }

    if (token.type !== 'heading_open') continue

    // heading level by hash length '###' === h3
    const level = token.markup.length

    if (level <= 1) continue

    const next = tokens[i + 1]
    const link = next.children?.find(child => child.type === 'link_open')
    const text = next.children?.filter(child => !!child.content).map(child => child.content).join('')
    const anchor = link?.attrs?.find(([attr]) => attr === 'href')
    const [, to] = anchor ?? []

    headings.push({
      text,
      to,
      level,
    })
  }

  return headings
}