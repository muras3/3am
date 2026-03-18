/**
 * Vercel Serverless Function entry point (api/index.ts).
 *
 * @vercel/node auto-detects this file and handles:
 *   - TypeScript compilation
 *   - ESM/CJS interop
 *   - Web Standard API (Request/Response) support via named exports
 *   - Dependency resolution via nft (Node File Trace)
 *
 * Named HTTP method exports are required by @vercel/node for Web Standard API.
 */
export { GET, POST, PUT, PATCH, DELETE, OPTIONS } from "../apps/receiver/src/vercel-entry.js";
