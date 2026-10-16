// What Next's bundled `server-only` resolves to outside a React Server
// environment. Outside Next the package does not exist at all, so importing any
// app module from a script dies at `Cannot find module 'server-only'`.
export {};
