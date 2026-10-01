/**
 * JSails docs-site app config.
 *
 * A static export has no server runtime: `jsails build` renders every page to
 * HTML, and writes the result into `out/`. The generated site is plain files —
 * deploy `out/` to any static host.
 */
export default {
  rootDir: '.',
  pages: 'dist/pages',
  public: 'public',
  out: 'out',
  host: '127.0.0.1',
  port: Number(process.env.PORT ?? 3001),
  plugins: {
    use: [],
  },
};
