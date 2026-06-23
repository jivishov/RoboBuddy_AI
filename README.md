# RoboBuddy 3D

This folder is the 3D-only static GitHub Pages version of RoboBuddy.

The browser entry points are:

- `index.html`
- `python.html`
- `gemini.html`
- `python-docs.html`

The 3D arm preview does not load raw STL, 3MF, or CAD files at runtime. The mesh geometry is baked into `simulator/js/arm-preview-mesh-data.js`, with the runtime in `simulator/js/` and `simulator/css/`.

Run locally with any static server from this folder, for example:

```powershell
python -m http.server 8090 --bind 127.0.0.1
```
