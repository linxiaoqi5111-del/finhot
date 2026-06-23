# Contributing to Focal

Thank you for considering contributing to Focal. This project focuses on a macOS local-first RSS reader with BYOK AI, embedding-based ranking, and knowledge-management integrations.

## Getting Started

Before you start contributing, please ensure you have enabled [Corepack](https://nodejs.org/api/corepack.html). Corepack ensures you are using the correct version of the package manager specified in the `package.json`.

```sh
corepack enable && corepack prepare
```

### Installing Dependencies

To install the necessary dependencies, run:

```sh
pnpm install
```

## Development Setup

### Develop the Renderer in the Browser

For a faster renderer development loop, run the desktop renderer in the browser:

```sh
cd apps/desktop && pnpm run dev:web
```

This starts the Vite renderer dev server. Browser mode is mainly for UI development; full local RSS behavior requires the Electron runtime.

### Develop the macOS Desktop App

For the full Focal desktop experience, run Electron:

0. Go to the `apps/desktop` directory:

   ```sh
   cd apps/desktop
   ```

1. Run the development server:

   ```sh
   pnpm run dev:electron
   ```

The current product scope is macOS desktop. Legacy mobile, SSR, and cloud-oriented code may still exist in the repository, but new contributions should target the Focal desktop/local-first path unless a maintainer explicitly scopes otherwise.

## Contribution Guidelines

- Ensure your code follows the project's coding standards and conventions.
- Write clear, concise commit messages.
- Include relevant tests for your changes.
- Update documentation as necessary.

## License

By contributing to Focal, you agree that your contributions will be licensed under the GNU Affero General Public License version 3, with the special exceptions noted in the `README.md`.
