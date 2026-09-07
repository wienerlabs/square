# Square site

The front door: what the protocol is, what it is built on, how it is used, and the door to the app at https://square-wienerlabs.vercel.app. A static Next.js export with no runtime data; the app is where the chain is read.

```console
$ npm install
$ npm run typecheck
$ npm run build
```

`npm run build` writes the site to `out/`. It is deployed as its own Vercel project from this directory.

The layout is adapted from an MIT template; see `THIRD_PARTY.md`. Every word and number on the page is Square's own, and the marks under `public/brand/` are used the way their owners ask.
