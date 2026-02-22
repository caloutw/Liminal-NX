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
- [x] Dynamic folder config.
- [x] RESTful with dynamic folder config.
- [ ] Websocket Support.
- [ ] A lot of optimization.

## Build
```shell
git clone https://github.com/caloutw/Liminal-NX.git Liminal-NX
```

```shell
npm run server
```

## Config

* `port`: Web server will use this port.
* `folder`: The folder location, must be an absolute location.
* `mjslife`
- * `MAX_RAM_SIZE`: Maximum memory limit (MB) for the new MJS isolation container.
- * `MAX_REQUEST`: Maximum queue capacity for MJS operations.
- * `MAX_LIFE_TIME`: MJS Max Execution Time (seconds)
- * `ERROR_DISPLAY`: Display MJS runtime errors directly on the webpage.

* `connectlife`
- * `REQUSET_THRESHOLD_TIME_s`: The time frame during which requests from a single IP are tracked. If the count exceeds `MAX_REQUESTS_s`, the IP will be blacklisted.
- * `MAX_REQUESTS_s`: The maximum number of requests an IP can make within the specified time window before being blacklisted.
- * `BLOCK_TIME_s`: The amount of time an IP address remains blocked after exceeding the request limit.
- * `MAX_PACKAGE_SIZE`: The maximum size (in bytes) of all HTTP request headers.



## Routing Logic

When a user requests a path (e.g., `/a`), **Liminal-NX** follows this execution flow:

### 1. Check .passfilter file

* **.passfilter**: Recursively checks parent directories for `.passfilter` files and applies the corresponding policies.

### 2. Path Resolution

* **Check Existence**: The server verifies if the requested path `a` exists as a file or a directory.
* **Not Found**: If the path does not exist, the server returns a **404 Not Found** error.

### 3. Directory Handling

If the path is a **Directory**:

* **Trailing Slash Check**: If the URL does not end with a slash (`/`), the server returns a **301 Moved Permanently** and redirects to the correct URL (e.g., `/a/`).
* **Index Lookup**: The server looks for index files in the following priority:
1. `index.mjs` (Top priority)
2. `index.html`

* **Internal 404**: If neither `index.mjs` nor `index.html` is found, it returns a **404 Not Found**.

### 4. File Execution & Serving

If the resolved target is a **File** (either the requested path or a resolved index file):

**Dynamic Execution (`.mjs`)**:
* If the file extension is `.mjs`, the server spawns a new **Node.js Isolation Container**.
* The script is executed within the defined resource limits (`MAX_RAM_SIZE`, `MAX_LIFE_TIME`, etc.).


**Static Serving**:
* For all other file extensions, the server streams the file content directly to the client.



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
* **Local node_modules**: You can install NPM packages directly in your web folders; Liminal-NX will automatically resolve the local `node_modules`. (If `node_modules` is not found in the current directory, the server will recursively search upwards through parent directories.)

## Passfilter

A configuration file used to block unauthorized access or redirect traffic to the correct destination, similar to `.htaccess`.

### Where to place it?
Place the `.passfilter` file inside your target folder. 

For example, if you want to prevent users from accessing `vip.png` at the `/games` URL, simply place the `.passfilter` file into the `/games` folder.

### File Structure

Please follow the JSON format. Rules defined at the top have a higher priority and will be triggered first.

```json
[
  { "action": "allow", "includes": [ "background.png" ] },
  { "action": "deny", "includes": [ "/*.db" ], "to": 418 },
  { "action": "forward", "includes": [ "*.php" ], "to": "phpProcess.mjs" },
  { "action": "forward", "includes": [ "/login" ], "to": "RESTful.mjs" }
]
```

`RESTful.mjs`

```javascript
export function main(req, res){
    let urlPath = req.url.split("/").slice(-2);
    
    res.write(`You are using RESTful API\n`);
    res.write(`${urlPath[0]} and ${urlPath[1]}`);
    res.end();
    return;
}
```

### Rules & Behaviors

* **Downward Inheritance**: All rules are inherited downwards by child directories. Parent directories will not follow child rules (which shouldn't happen anyway).
* **Directory Lock (`/`)**: If an item in `includes` starts with a slash (`/`), the rule is locked to the current directory and will **not** be applied to its subdirectories.
* **Multiple Targets**: The `includes` array can contain multiple files or patterns.
* **Action Parameters**: Only the `deny` and `forward` actions support the `to` parameter. If you attempt to use `to` with an `allow` action, it will be ignored.
* **Routing Behavior (`to`)**: If the `to` value is a number, the server returns the corresponding HTTP error code. If it is a string, it routes the request to the specified file (relative to the `.passfilter` location).
* **Priority & Short-Circuiting**: Rule priority is bottom-up. The `.passfilter` in the immediate requested directory has the highest authority, decreasing as it traverses up the parent directories. Evaluation uses a "first-match wins" strategy—once a rule is hit, all subsequent rules are immediately skipped.

### About RESTful Routing

I have already demonstrated this in the fourth item of the list.

## Ok.

Have a nice day :)