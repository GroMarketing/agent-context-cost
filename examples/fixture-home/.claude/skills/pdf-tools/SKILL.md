---
name: pdf-tools
description: Extract text and tables from PDF files, merge or split documents, and fill simple forms. Use when the user mentions a .pdf file or asks to combine, split or read one.
---

# pdf-tools

1. Read the file with a PDF text extractor before guessing at its layout.
2. For tables, extract page by page and keep the header row.
3. To merge, keep the original page order unless asked otherwise.
4. To split, name output files after the page ranges.
5. Report pages that had no extractable text (they are probably scans).

```bash
pdftotext -layout input.pdf out.txt
qpdf --empty --pages a.pdf b.pdf -- merged.pdf
```
