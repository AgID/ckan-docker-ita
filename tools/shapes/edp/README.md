# Shape EDP (piveau)

Copia di `shapes.ttl`, `deprecateduris.ttl` e `shapes_recommended.ttl`, DCAT-AP 3.0.1,
dal progetto [piveau-metrics-validating-shacl](https://gitlab.com/piveau/metrics/piveau-metrics-validating-shacl)
(`src/main/resources/rdf/shapes/dcat-ap/3.0.1/`, branch `develop`).
Rispetto alla 3.0.0 cambia solo `dcat:byteSize`: `xsd:nonNegativeInteger` invece di
`xsd:decimal`. data.europa.eu valida con `dcatap301level1` dal 07/11/2026.

Copyright 2019 Fraunhofer FOKUS, Apache License 2.0.

Le usa il validatore web, che le include nella pagina. Lo script
`tools/validate_edp_shacl.py` continua a scaricarle da gitlab.com, cosi' segue
eventuali aggiornamenti di piveau; se le due versioni divergono, va aggiornata
questa copia.
