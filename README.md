# Control de Inventario de Tarjetas

App para identificar faltantes y sobrantes de tarjetas comparando códigos físicos (escaneados por cámara) contra los códigos del sistema.

## Características

- Carga masiva de códigos del sistema (copia/pega)
- Escaneo OCR por cámara para códigos de 17 dígitos
- Entrada manual como respaldo
- Detección automática de duplicados
- Lista ordenada de menor a mayor
- Comparación: faltantes, sobrantes y coincidencias
- Exportar reporte en .txt

## Desarrollo local

```bash
npm install
npm run dev
```

## Deploy en Vercel

1. Sube este proyecto a un repositorio de GitHub
2. Entra a [vercel.com](https://vercel.com) y conecta tu cuenta de GitHub
3. Importa el repositorio
4. Vercel detecta Vite automáticamente — sin configuración extra
5. Haz clic en **Deploy**

## Notas

- La cámara requiere HTTPS. Vercel lo provee automáticamente.
- Para mejor lectura OCR: buena iluminación y código centrado en el recuadro.
