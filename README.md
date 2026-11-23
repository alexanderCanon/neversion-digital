# neversion-digital
Neversion Digital es una aplicación móvil para distribuidores de servicios digitales. Permite registrar clientes, organizar sus suscripciones y dar seguimiento a vencimientos y renovaciones desde un solo lugar.

## Desarrollo local

Requiere Node.js 24. El panel administra un negocio y ofrece cuentas de operador revocables con fecha de caducidad. El precio de una suscripción se guarda en centavos de quetzal al crearla.

```sh
cd apps/api
npm ci
cp .dev.vars.example .dev.vars
npx wrangler d1 migrations apply DB --local
npm run dev -- --ip 0.0.0.0
```

En otra terminal, copia `apps/mobile/.env.example` como `apps/mobile/.env` y pon la URL de tu Worker. Para un teléfono en la misma red, usa la IP local de tu equipo y el puerto 8787.

```sh
cd apps/mobile
npm ci
npm start
```

## Despliegue manual

En GitHub Actions, configura `CLOUDFLARE_API_TOKEN` como secreto y `CLOUDFLARE_ACCOUNT_ID` como variable. El token necesita acceso de escritura a D1 y permisos para publicar el Worker, incluida su creación en el primer despliegue.

Para habilitar el inicio de sesión, configura además la variable `ADMIN_EMAIL` y el secreto `ADMIN_PASSWORD` con una contraseña única de al menos 16 caracteres. El workflow publica esos valores como secretos del Worker. Si prefieres gestionarlos desde Cloudflare, configura ambos como secretos directamente en el Worker.

En Actions, ejecuta **Desplegar API en Cloudflare** desde `main`. El workflow vuelve a ejecutar CI, prepara D1, aplica las migraciones y comprueba `/health`. La URL aparece en el resumen y sirve como `EXPO_PUBLIC_API_URL` para la app. La distribución de los binarios móviles se hace por separado.

### Integraciones

- **Comprobantes.** En GitHub Actions, define `RECEIPT_VALIDATOR_SERVICE=receipt-validator` y el secreto `RECEIPT_INTEGRATION_KEY` (32 caracteres aleatorios como mínimo). Configura el mismo secreto en el Worker de Receipt Validator. Despliega primero la versión del validador que incluye el endpoint de integración.
- **Telegram.** Define el secreto `REMINDER_API_KEY` (32 caracteres aleatorios como mínimo). El Worker de recordatorios debe tener el mismo secreto y un binding al Worker `neversion-digital-api`. Usa claves distintas para las dos integraciones.
