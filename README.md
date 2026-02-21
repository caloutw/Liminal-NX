<div align="center">
    <h1>Liminal-NX</h1>
    <p>A real-time static file server with a unified JavaScript-based backend.</p>
</div>

<div align="center">

![node version](https://badgen.net/badge/color/v25.0/blue?label=node%20version)

</div>

## Todo
- [x] MJS Runtime Support.
- [x] Sandbox isolation.
- [x] TCP Keep-Alive Support.
- [x] Local `node_modules` Resolution.
- [ ] Websocket Support.
- [ ] Dynamic folder config.
- [ ] RESTful with dynamic folder config.
- [ ] A lot of optimization.

## Build
```shell
git clone https://github.com/caloutw/Liminal-NX.git Liminal-NX
```

```shell
npm run server
```

## Config
- `port`: Web server will use this port.
- `folder`: The folder location, must be an absolute location.
- `mjslife`
- - `MAX_RAM_SIZE`: Maximum memory limit (MB) for the new MJS isolation container.
- - `MAX_REQUEST`: Maximum queue capacity for MJS operations.
- - `MAX_LIFE_TIME`: MJS Max Execution Time (seconds)
- - `ERROR_DISPLAY`: Display MJS runtime errors directly on the webpage.
- `connectlife`
- - `REQUSET_THRESHOLD_TIME_s`: The time frame during which requests from a single IP are tracked. If the count exceeds `MAX_REQUESTS_s`, the IP will be blacklisted.
- - `MAX_REQUESTS_s`: The maximum number of requests an IP can make within the specified time window before being blacklisted.
- - `BLOCK_TIME_s`: The amount of time an IP address remains blocked after exceeding the request limit.
- - `MAX_PACKAGE_SIZE`: The maximum size (in bytes) of all HTTP request headers.

## Routing Logic

When a user requests a path (e.g., `/a`), **Liminal-NX** follows this execution flow:

### 1. Path Resolution
* **Check Existence**: The server verifies if the requested path `a` exists as a file or a directory.
* **Not Found**: If the path does not exist, the server returns a **404 Not Found** error.

### 2. Directory Handling
If the path is a **Directory**:
* **Trailing Slash Check**: If the URL does not end with a slash (`/`), the server returns a **301 Moved Permanently** and redirects to the correct URL (e.g., `/a/`).
* **Index Lookup**: The server looks for index files in the following priority:
  1. `index.mjs` (Top priority)
  2. `index.html`
* **Internal 404**: If neither `index.mjs` nor `index.html` is found, it returns a **404 Not Found**.

### 3. File Execution & Serving
If the resolved target is a **File** (either the requested path or a resolved index file):
* **Dynamic Execution (`.mjs`)**: 
  - If the file extension is `.mjs`, the server spawns a new **Node.js Isolation Container**.
  - The script is executed within the defined resource limits (`MAX_RAM_SIZE`, `MAX_LIFE_TIME`, etc.).
* **Static Serving**: 
  - For all other file extensions, the server streams the file content directly to the client.

## MJS Scripting Guide

To execute server-side logic, ensure your `.mjs` files follow the **Liminal-NX** entry point specification. The server automatically handles the isolation and passes the request/response objects to your `main` function.

### File Structure
Every `.mjs` file must export an `async function main(req, res)`.

```javascript
// You can use ESM imports or CommonJS require
import os from 'os';

export async function main(req, res) {
    if (req.method !== "POST") {
        res.statusCode = 405;
        return res.end("Only POST requests are accepted.");
    }

    if (req.body) {
        res.write("Message received successfully.");
    }
    
    res.end();
}
```

### Key Features

* **Auto-Parsing**: The `req.body` is pre-processed and available within the `main` function.
* **Isolation**: Each request runs in a fresh isolation container according to your `MAX_RAM_SIZE` settings.
* **Async Support**: The `main` function is awaited, allowing you to perform database queries or fetch calls seamlessly.
* **Local node_modules**: You can install NPM packages directly in your web folders; Liminal-NX will automatically resolve the local `node_modules`.

## Ok.
Have nice day :)