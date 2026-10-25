# Visión · LHSCOL

Sistema de inscripciones aislado de la web actual. La referencia de diseño es `prototipo/index.html`; la lógica, seguridad y datos siguen `SPEC.md`.

## Estado

- Estructura base para frontend estático, Functions, Rules, emuladores y pruebas.
- Reserva transaccional: máximo por grupo, precio calculado en servidor, cierre, cupo, autorización, trampa antispam, límite de solicitudes activas por WhatsApp/IP y tokens de gestión de 128 bits.
- Carga de comprobante mediante URL firmada, límite de 5 MB, tipo permitido y validación de firma de bytes al finalizar.
- Las Rules niegan acceso directo del público a Firestore y Storage.
- Fases 0 y 1 verificadas con emuladores: inscripción familiar, validaciones y concurrencia sobre Firestore.
- Fase 2 verificada con emuladores: panel `/admin` protegido, aprobación transaccional, cuatro boletas por grupo de cuatro, contabilidad e historial de auditoría.

## Preparación local

1. Instala una distribución de Node.js que incluya `npm` (Node 20 LTS o posterior).
2. Ejecuta `npm install` en la raíz y `npm install` dentro de `functions/`.
3. Copia `.env.example` a `.env.local` y completa únicamente los valores públicos del proyecto nuevo `lhscol-vision`.
4. Ejecuta `npm run test` y luego `npm run test:emulators`.

## Datos privados de pago para emuladores

`test-data/payment.local.json` y el QR al que apunte son locales e ignorados por Git. Copia `test-data/payment.local.example.json`, complétalo localmente y, con los emuladores activos, usa `npm run seed:emulator -- <eventId>` para cargar ambos datos en `events/{eventId}/private/config` y Storage local.

En producción el propietario carga el enlace de pago y el QR desde el panel administrativo; nunca se incluyen en el frontend, los archivos publicados ni el repositorio. El directorio `prototipo/` también es una referencia local ignorada y no forma parte de la publicación de Netlify.

No se debe desplegar, crear un proyecto Firebase real, activar Blaze ni configurar secretos sin confirmación explícita de la persona propietaria.

## Fuentes de configuración

Los datos privados de pago, el aforo y la configuración anual viven en `events/{eventId}/private/config`. No se incluyen enlaces de pago ni secretos en el frontend.
