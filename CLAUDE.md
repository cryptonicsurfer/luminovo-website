# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Luminovo Website - A modern Next.js 15 website for a Swedish luxury lamp boutique featuring AI-designed lighting products. Built with TypeScript, Tailwind CSS v4, and React 19.

**Fork för AI-labbet (2026-08):** bildgenerering via **fal.ai** (`src/lib/lamp-pipeline.ts`,
`/api/generate-lampshade`), 3D-modellen byggs av Claude Code i terminalen i
`../build123d-tests` och publiceras till `public/models/<id>/` med
`tools/build.py --publish`. Sajten pollar `/api/models/<id>` och visar
`<model-viewer>`. Meshy och Gemini-bildkedjan är borttagna; Gemini finns kvar
bara i `/api/estimate-price`. Lokal demo — inte Vercel-deploybar. Läs README
och `specs/fal-och-terminalbyggd-3d.md` innan du ändrar flödet.

## Development Commands

```bash
npm run dev          # Start development server with Turbopack at localhost:3000
npm run build        # Build for production with Turbopack
npm run start        # Start production server
npm run lint         # Run ESLint for code quality checks
npm run generate-image  # Run custom lampshade image generation script
```

## Architecture

### Tech Stack
- **Next.js 15.5.3** - App Router for server components and routing
- **React 19.1.0** - Latest React with server component support
- **TypeScript** - Strict mode enabled for type safety
- **Tailwind CSS v4** - Loaded via CDN in layout.tsx with custom CSS variables
- **Google Fonts** - Poppins font family (weights: 400, 500, 600, 700)

### Project Structure
- `/src/app/` - Next.js App Router pages and layouts
  - `page.tsx` - Single-page application with all sections (Hero, Philosophy, Collection, Sustainability, Newsletter)
  - `layout.tsx` - Root layout with metadata and font configuration
  - `globals.css` - Global styles with custom CSS variables for brand colors
- `/src/lib/utils.ts` - Utility functions including `cn()` for className merging (clsx + tailwind-merge)

### Design System
- **Brand Colors** (defined as CSS variables in globals.css):
  - `--brand-sand: #f1e9e0` - Primary background
  - `--brand-black: #1a1a1a` - Text and accents
  - `--brand-terracotta: #b97b5e` - Primary accent
  - `--brand-ochre: #E6A05D` - Secondary accent
  - `--brand-white: #FFFFFF` - Light backgrounds

### Code Patterns
- All components are currently inline in `page.tsx` as a single-page application
- Tailwind classes are used directly in JSX with responsive modifiers
- SVG logo is embedded inline for performance
- Images use external URLs (Google Cloud Storage)
- Custom utility classes defined in globals.css (`hero-bg`, `shadow-terracotta`)

### TypeScript Configuration
- Path alias: `@/*` maps to `./src/*`
- Strict mode enabled with all strict checks
- Target: ES2017
- Module resolution: bundler