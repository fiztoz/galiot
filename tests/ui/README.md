# Explorer browser checks

From the repository root run `bun run test:ui`, then open **http://127.0.0.1:5187/tests/ui/checks.html** and choose **Run local fixture checks**. Reload that page to run it again. For manual pointer or keyboard checks use **/tests/ui/index.html** on the same origin. Stop the server with Ctrl-C.

This separate Vite build has no S3 proxy. It renders the actual Explorer, editor, PDF.js, transfer drawer and an in-memory PGlite database. The vault returns canned fixture responses. Retry records task keys rather than contacting a worker or resuming a download. The annotated PDF is generated sample content; the checks follow its internal destination only.

The fixed scenarios use component DOM events, the browser's actual layout/hit tests and selection API. They cover 390/920/1440 px, selection, shortcuts, density, preview reflow, resize limits, modal focus, text/binary/PDF routing, PDF text/link geometry and aggregate retry. In the pointer scenario only the hardware capture call is stubbed: a DOM-generated pointer has no physical capture session. No system clipboard, real S3 operation or OS drag is part of these checks. No test assets are included in the normal app build.
