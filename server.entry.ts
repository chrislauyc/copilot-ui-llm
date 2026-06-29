import { app, initLogFile } from './server';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import express from 'express';
import { initializeWorkspace } from './src/workspace';

const PORT = parseInt(process.env.PORT || '3000', 10);

async function start() {
  await initializeWorkspace();
  // Vite preview or static file serving
  if (process.env.NODE_ENV !== 'production' && process.env.NODE_ENV !== 'test') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    initLogFile();
    console.log(`Server running on port ${PORT}`);
  });
}

start();
