import { createLibraryHandler } from './handler.mjs';
Deno.serve(createLibraryHandler({ env: Deno.env.toObject() }));
