// pdf.js ships its worker as a plain `.mjs` module without typings. The mod
// imports it for its side effect only: evaluating it installs
// `globalThis.pdfjsWorker`, which makes pdf.js use its main-thread "fake
// worker" path (see the comment in Reader.tsx `getPdfjs`).

declare module 'pdfjs-dist/build/pdf.worker.min.mjs' {
  export const WorkerMessageHandler: unknown
}
