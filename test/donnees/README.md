# Jeux d’essai étrangers

Ces fichiers ne sont pas écrits par le moteur : ils prouvent que `lire` comprend ce que
d’autres logiciels produisent. Fabriqués le 2026-11-21.

| Fichier | Fabriqué par | Ce qu’il éprouve |
|---|---|---|
| `origine-facture.xml`, `origine-avoir.xml` | ce moteur, `versXml` | la référence : ce que la lecture doit retrouver |
| `mustang-ubl-facture.xml`, `mustang-ubl-avoir.xml` | Mustang 2.26.0, `--action ubl` | UBL 2.1, `Invoice` et `CreditNote` |
| `mustang-facturx-pdfbox.pdf` | Mustang 2.26.0 (Apache FOP puis PDFBox), `--action pdf` puis `combine` | `/EF` indirect, fichier joint non compressé, PDF/A-3U |
| `pdflib-flux-objets.pdf` | pdf-lib, `useObjectStreams: true` | fiche de fichier cachée dans un flux d’objets compressé |

Mustang est sous licence Apache 2.0, pdf-lib sous licence MIT. Aucun des deux n’est une
dépendance du moteur : ils ont servi une fois, à fabriquer ces fichiers. L’essai oracle
(`FACTURX_ORACLE=1 npm test`) refait la conversion Mustang à chaque passage.
