// What `postcss` resolves to in browser bundles (next.config.js → turbopack.resolveAlias, the
// `browser` condition only; server bundles and the build's own CSS pipeline get the real postcss).
//
// sanitize-html, the authored-HTML allowlist in @nextblock-cms/utils, requires postcss as it
// loads but calls it only to parse style attributes, which sanitizeAuthoredBlockHtml turns off
// (`parseStyleAttributes: false`). Nothing else in a client bundle imports postcss, so without
// this every client bundle that imports the sanitizer carried all of postcss (about 18 KB
// gzipped) for code that never runs. postcss.test.ts runs the sanitizer against this stub and
// fails the day sanitize-html starts using postcss for anything else.
module.exports = {};
