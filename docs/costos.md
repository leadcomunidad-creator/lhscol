# Costos y límites revisados — 25 de octubre de 2026

Esta revisión es informativa: **no** se activó facturación, no se creó un proyecto Firebase ni se desplegó ningún recurso.

## Hallazgos vigentes

- Cloud Functions for Firebase requiere Blaze. El plan conserva una capa sin costo de 2 millones de invocaciones/mes, 400.000 GB-segundos, 200.000 CPU-segundos y 5 GB/mes de red saliente; después aplica cobro por uso.
- Cloud Firestore Standard tiene, por proyecto, una capa sin costo de 50.000 lecturas/día, 20.000 escrituras/día, 20.000 eliminaciones/día, 1 GiB almacenado y 10 GiB/mes de transferencia saliente. Consultas e índices también pueden generar lecturas facturables.
- Cloud Storage depende del tipo de bucket. Para buckets `*.firebasestorage.app`, la página de precios muestra 5 GB-mes, 100 GB/mes de descarga, 5.000 cargas/mes y 50.000 descargas/mes sin costo antes del precio de Google Cloud.
- App Check no tiene precio propio, aunque sus proveedores de attestación tienen cuotas. Las alertas de presupuesto avisan: no detienen por sí solas el consumo. Functions 2.ª generación se ejecuta sobre Cloud Run y Firebase recomienda además un límite de gasto de Cloud Run.

## Decisión previa al despliegue

Antes de la Fase 4, la persona propietaria debe confirmar: región definitiva, cuenta de facturación del proyecto nuevo, alertas de USD 5/10/20 y un límite de gasto de Cloud Run si está disponible. El código deja `maxInstances: 5` y `minInstances: 0` como medidas de contención iniciales.

Fuentes oficiales consultadas: Firebase Pricing, documentación de precios de Firestore y cuotas de Cloud Functions (25 de octubre de 2026).
