# Luminovo Website

> **Demo-läge för AI-labbet (2026-08).** Den här forken byter Gemini + Meshy mot
> **fal.ai** (bild) + **Claude Code i terminalen** (3D-modell med riktiga mått).
> Det är en **lokal demo-arkitektur**: servern skriver genererade bilder till
> `public/models/<id>/` i runtime, vilket inte fungerar på Vercel. Kör med
> `npm run dev`.
>
> **Flödet på scen**
> 1. Skriv en lampidé på sajten → `POST /api/generate-lampshade` → fal.ai
>    (Seedream v5 lite) → `public/models/<id>/bild.jpg` + `meta.json`.
> 2. I terminalen, i `../build123d-tests`: Claude Code läser bilden, skriver en
>    måttspec och en build123d-del, och kör
>    `uv run python tools/build.py parts/<del>.py --publish ../luminovo-website/public/models/<id> --spec ref/<spec>.md`
> 3. Sajten pollar `/api/models/<id>` var 3:e sekund och visar `<model-viewer>`
>    (GLB, AR via USDZ) så fort `modell.glb` finns. Vid omladdning visas
>    senaste modellen.
>
> **Eller i appen:** knappen "Bygg modellen i appen" startar `POST /api/models/<id>/build`
> — en EU-hostad modell via TensorX (default `z-ai/glm-5.3-flash`) läser bilden, skriver
> spec + build123d-kod, servern kör `build.py`, och fel + rendering går tillbaka till
> modellen i upp till tre varv. Status i `public/models/<id>/agent.json`. Loopen kör kod
> som en språkmodell skrivit, lokalt — det är avsikten, och skälet till att detta aldrig
> deployas. Spec: `specs/tensorx-byggagent.md`.
>
> `npm run dev` binder bara `127.0.0.1` — med flit. För QR-akten (publiken snurrar
> modellen och öppnar AR på sina telefoner) finns `npm run dev:lan` (0.0.0.0) — kör
> det **bara på ett wifi ni litar på och bara under den akten**: båda endpoints är
> publika, den ena kostar pengar och den andra kör kod. Alternativet utan LAN är att
> ladda ner USDZ:n på Macen och AirDroppa den till telefonen.
>
> Nycklar: `FAL_API_KEY`, `TENSORX_API_KEY` i `.env.local` (se `.env.example`). Spec:
> `specs/fal-och-terminalbyggd-3d.md`. Tester: `npm test`.


A modern, responsive website for Luminovo - an AI-powered design studio that creates custom lighting in minutes. Built with Next.js 15, TypeScript, Tailwind CSS v4, and shadcn/ui components.

## 🌟 Features

- **Modern Tech Stack**: Next.js 15 with App Router, TypeScript, Tailwind CSS v4
- **AI Design Studio**: Interactive demo showing the 3-minute lamp design process
- **Responsive Design**: Optimized for all devices with mobile-first approach
- **Scandinavian Aesthetic**: Clean, minimalist design with custom color palette
- **Interactive Components**: Smooth animations and hover effects
- **Optimized Performance**: Fast loading with Next.js optimizations
- **Accessibility**: WCAG compliant with semantic HTML

## 🎨 Design System

### Colors
- **Brand Sand**: #f1e9e0 (Primary background)
- **Brand Black**: #1a1a1a (Text and accents)
- **Brand Terracotta**: #b97b5e (Primary accent)
- **Brand Ochre**: #E6A05D (Secondary accent)

### Typography
- **Primary Font**: Poppins (Google Fonts)
- **Weights**: 300, 400, 500, 600, 700

## 🚀 Getting Started

1. **Install dependencies**
   ```bash
   npm install
   ```

2. **Start the development server**
   ```bash
   npm run dev
   ```

3. **Open your browser**
   Navigate to `http://localhost:3000`

## 📁 Project Structure

```
src/
├── app/
│   ├── globals.css          # Global styles and Tailwind config
│   ├── layout.tsx           # Root layout with metadata
│   └── page.tsx             # Home page component
├── components/
│   ├── header.tsx           # Navigation header with mobile menu
│   ├── hero.tsx             # Hero section with interactive demo
│   ├── how-it-works.tsx     # 3-step process explanation
│   ├── features.tsx         # Technology features section
│   ├── pricing.tsx          # Pricing tiers display
│   ├── contact.tsx          # Contact info and newsletter signup
│   ├── footer.tsx           # Site footer with links
│   └── logo.tsx             # SVG logo component with variants
```

## 🎯 Key Components

### Interactive Demo
The hero section features an interactive 3-step demo:
1. **Style Selection**: Choose from 4 design categories
2. **AI Generation**: Animated progress showing AI at work
3. **360° Preview**: Final design with pricing and AR preview

### Responsive Navigation
- Sticky header with scroll detection
- Mobile hamburger menu
- Smooth scrolling to sections
- Dynamic styling based on scroll position

### Email Subscription
- Form validation with loading states
- Success/error feedback
- Privacy-conscious design

## 🛠 Available Scripts

- `npm run dev` - Start development server with Turbopack
- `npm run build` - Build for production
- `npm run start` - Start production server
- `npm run lint` - Run ESLint

## 🔧 Technical Decisions

### Next.js 15 with App Router
- Server Components for better performance
- Client Components for interactivity
- Optimized font loading with next/font

### Tailwind CSS v4
- New @theme directive for configuration
- Custom CSS variables for brand colors
- Responsive utility classes

### shadcn/ui Integration
- Pre-configured component library
- Consistent design system
- Accessible components

## 📱 Responsive Design

The site is fully responsive with:
- Mobile-first approach
- Breakpoints: sm (640px), md (768px), lg (1024px), xl (1280px)
- Flexible grid layouts
- Optimized touch interactions

## 🎨 Animations

- CSS transitions for hover effects
- Keyframe animations for the AI demo
- Smooth scrolling navigation
- Loading states and micro-interactions

## 🔍 SEO & Performance

- Optimized metadata and Open Graph tags
- Next.js Image optimization
- Font display optimization
- Semantic HTML structure

## 🌐 Browser Support

- Modern browsers (Chrome, Firefox, Safari, Edge)
- Mobile browsers (iOS Safari, Chrome Mobile)
- Progressive enhancement for older browsers

---

Built with ❤️ using Next.js, TypeScript, and Tailwind CSS
