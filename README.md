# Dropbox Hostinger Probe

Aplicacion minima para probar cargas Dropbox desde Hostinger sin Next.js, MySQL ni la app principal.

## Endpoints

- `GET /`: formulario de prueba.
- `GET /health`: estado basico.
- `GET /dropbox/status`: valida token, cuenta y metadata de raices.
- `POST /upload`: sube archivo pequeno en JSON base64.

## Hostinger

- Framework / runtime: Node.js app.
- Build command: vacio o `npm install`.
- Start command: `npm run start`.
- Output directory: `./` si el panel lo solicita.

## Seguridad

No hay secretos en el repositorio. Todas las llaves de Dropbox van en variables de entorno de Hostinger.
