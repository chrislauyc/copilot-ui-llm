import express from "express";
import { createServer as createViteServer } from "vite";
import { exec } from "child_process";
import path from "path";
import fs from "fs";

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // Store active sessions (very simple mapping of ID to current directory)
  const sessions: Record<string, string> = {};

  app.post("/api/exec", (req, res) => {
    const { command, sessionId = "default" } = req.body;

    if (!command) {
      res.status(400).json({ error: "No command provided" });
      return;
    }

    // Default to workspace root if no session exists
    const currentCwd = sessions[sessionId] || process.cwd();

    // Execute the command in the current directory
    exec(command, { cwd: currentCwd }, (error, stdout, stderr) => {
      // If the command was 'cd', we want to update the session's CWD
      // However, 'cd' in exec doesn't affect the parent process.
      // We can try to guess or handle cd specifically if needed.
      // A better way is to execute 'command && pwd' to see where we ended up.
      
      const updateCwdCmd = `${command} && pwd`;
      exec(updateCwdCmd, { cwd: currentCwd }, (err, out) => {
          if (!err) {
              const newCwd = out.trim().split('\n').pop(); // Get last line of output
              if (newCwd && fs.existsSync(newCwd)) {
                  sessions[sessionId] = newCwd;
              }
          }
          
          res.json({
            stdout: stdout,
            stderr: stderr,
            currentCwd: sessions[sessionId] || currentCwd
          });
      });
    });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
