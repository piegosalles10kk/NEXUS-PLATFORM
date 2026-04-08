import { Client } from 'ssh2';

export interface SSHOptions {
  host: string;
  username: string;
  port?: number;
  privateKey?: string;
  password?: string;
}

/**
 * Executes a shell command on a remote server via SSH.
 * Streams stdout and stderr back via onData callback line by line.
 * Rejects if the remote command exits with a non-zero code.
 */
export function executeSSHCommand(
  opts: SSHOptions,
  command: string,
  onData: (data: string) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const conn = new Client();

    conn.on('ready', () => {
      conn.exec(command, (err, stream) => {
        if (err) {
          conn.end();
          return reject(err);
        }

        stream.on('data', (chunk: Buffer) => onData(chunk.toString()));
        stream.stderr.on('data', (chunk: Buffer) => onData(chunk.toString()));

        stream.on('close', (code: number | null) => {
          conn.end();
          if (code === 0 || code === null) {
            resolve();
          } else {
            reject(new Error(`SSH command exited with code ${code}`));
          }
        });
      });
    });

    conn.on('error', (err) => reject(err));

    conn.connect({
      host: opts.host,
      port: opts.port ?? 22,
      username: opts.username,
      ...(opts.privateKey
        ? { privateKey: Buffer.from(opts.privateKey.replace(/\\n/g, '\n')) }
        : { password: opts.password }),
      readyTimeout: 15000,
    });
  });
}
