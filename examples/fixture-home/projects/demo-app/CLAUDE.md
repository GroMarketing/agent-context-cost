# demo-app

A small web app with an API package and a web package.

## Commands

- Install: `npm install`
- Test: `npm test`
- Lint: `npm run lint`
- Dev server: `npm run dev` (port 3000)

## Layout

- `packages/api`: HTTP handlers, validation, database access
- `packages/web`: UI components and pages
- `migrations/`: SQL migrations, one file per change

## Conventions

- Handlers validate input at the edge and return typed errors.
- Database access goes through the repository layer, never from handlers.
- New endpoints need a test for the happy path and one failure case.
