# oneJournal

A cross-platform note-taking application supporting handwritten notes, text, and drawings with WebDAV sync support.

## Features (Planned)

- 📝 Rich text editing
- ✍️ Handwriting support with active stylus
- 🎨 Drawing canvas with pressure sensitivity
- 🔄 WebDAV sync (Nextcloud compatible)
- 💾 Offline-first with IndexedDB storage
- 📱 Progressive Web App (PWA)
- 🌐 Cross-platform (runs in any modern browser)

## Quick Start

### Prerequisites

- Node.js (v18 or higher)
- npm (comes with Node.js)
- [just](https://github.com/casey/just) (optional, for task running)

### Installation

```bash
# Install dependencies
npm install
# or
just install
```

### Development

```bash
# Start development server
npm run dev
# or
just dev
```

The app will open at `http://localhost:3000`

### Build

```bash
# Build for production (creates single HTML file)
npm run build
# or
just build
```

The built app will be in the `dist/` folder as a self-contained `index.html` file.

### Code Quality

```bash
# Run linter
npm run lint
# or
just lint

# Format code
npm run format
# or
just format

# Check formatting
npm run format-check
# or
just format-check

# Run all checks
just check
```

## Project Structure

```
oneJournal/
├── index.html          # Main HTML entry
├── src/
│   ├── main.js         # Application entry point
│   ├── components/     # UI component templates
│   ├── modules/        # Core logic (storage, sync, canvas)
│   └── styles/         # CSS files
├── public/             # Static assets
├── dist/               # Build output
├── package.json
├── vite.config.js      # Vite configuration
├── justfile            # Task runner commands
└── README.md
```

## Technology Stack

- **Frontend**: Vanilla HTML/CSS/JavaScript (ES6+)
- **Build Tool**: Vite
- **Local Storage**: IndexedDB
- **Sync**: WebDAV
- **Code Quality**: ESLint + Prettier

## Development Status

Currently in Phase 1: Core Infrastructure Setup

See [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) for detailed roadmap.

## License

MIT
