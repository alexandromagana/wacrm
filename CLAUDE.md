@AGENTS.md

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).

## Cotizaciones

El PDF que recibe el cliente lo arma `src/lib/quotes/`, dibujando sobre el
template de `public/quotes/template.pdf` que produce
`scripts/build-quote-template.mjs` a partir del export de Figma en `design/`.

Antes de tocar ese módulo o el diseño:

- `docs/quote-design.md` — las reglas del documento (paleta, el anexo Nuvolt,
  las dos orientaciones, qué significa cada color) y qué hacer cuando el
  diseño cambia en Figma.
- `docs/quote-handoff.md` — el contrato de datos, el formato de los números y
  las validaciones antes de renderizar. Trae arriba una tabla de qué secciones
  ya quedaron superadas por el código.

Dos trampas que cuestan caro: los campos variables tienen que estar en opacidad
0 en Figma, porque si no se enciman con el valor; y las tasas de Nuvolt están tanto en el
arte como en `PLANES` de `src/lib/quotes/financing.ts` — se cambian en los dos
lados o el documento se contradice solo.
