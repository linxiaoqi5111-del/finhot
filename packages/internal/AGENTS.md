# AGENTS.md

This file provides specific guidance for developing shared packages used by the desktop app.

## Overview

The `packages/internal/` directory contains core shared packages that provide common functionality for the desktop RSS reader.

## Package Structure

- `atoms/` - Jotai atomic state definitions
- `components/` - Shared UI components
- `constants/` - Application constants
- `database/` - Drizzle ORM database layer
- `hooks/` - Shared React hooks
- `models/` - Data models and schemas
- `shared/` - Cross-platform shared utilities
- `store/` - Zustand stores
- `types/` - TypeScript type definitions
- `utils/` - Utility functions and helpers
- `tracker/` - Analytics and tracking
- `logger/` - Logging utilities
- `legal/` - Legal and compliance utilities

## State Management

- **Jotai** for atomic state management across all platforms
- **Zustand** for complex state stores (in `packages/internal/store/`)
- **React Query** for server state management

## Database

- **Drizzle ORM** with SQLite for local data storage
- Desktop database implementations live in `packages/internal/database/`
- Migration system with versioned SQL files

## Component Development Guidelines

- Shared UI components in `packages/internal/components/`
- App-specific components live in `apps/desktop`
- Use TypeScript interfaces for component props
- Follow cross-platform compatibility patterns
