import * as http from 'http';
import * as https from 'https';
import * as net from 'net';
import * as tls from 'tls';

export class CustomHttpsProxyAgent extends https.Agent {
    private proxy: URL;

    constructor(proxyUrl: string, opts?: https.AgentOptions) {
        super(opts);
        this.proxy = new URL(proxyUrl);
    }

    // @ts-ignore
    createConnection(options: any, callback: (err: Error | null, socket?: net.Socket) => void): void {
        const proxyReq = http.request({
            host: this.proxy.hostname,
            port: this.proxy.port || 80,
            method: 'CONNECT',
            path: `${options.host}:${options.port}`,
            headers: {
                host: options.host
            }
        });

        proxyReq.on('connect', (res, socket) => {
            if (res.statusCode !== 200) {
                socket.destroy();
                callback(new Error(`Proxy connection failed with status ${res.statusCode}`));
                return;
            }

            const tlsSocket = tls.connect({
                socket: socket as net.Socket,
                host: options.host,
                servername: options.host || options.servername,
                rejectUnauthorized: this.options.rejectUnauthorized
            });

            callback(null, tlsSocket);
        });

        proxyReq.on('error', (err) => {
            callback(err);
        });

        proxyReq.end();
    }
}
