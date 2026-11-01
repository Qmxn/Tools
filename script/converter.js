const fs = require('fs');
const path = require('path');
const { https } = require('follow-redirects');
const pLimit = require('p-limit');

// --- 配置 ---
const CONFIG = {
    // 环境变量优先，默认为 Qmxn/Tools 的 API（通过 GitHub 访问）
    REPO_API_URL: process.env.REPO_API_URL || "https://api.github.com/repos/Qmxn/Tools/contents/Plugin",
    OUTPUT_DIR: path.resolve(process.cwd(), "Modules"),
    SCRIPT_HUB_PATH: path.resolve(process.cwd(), "Script-Hub"),
    LOCAL_PLUGIN_DIR: path.resolve(process.cwd(), "Tools/Plugin"), // 降级备用路径
    CONCURRENCY: 5,                              // 并发数
    TIMEOUT_MS: 20000,                           // 单个转换超时 20 秒
};

// --- 主函数 ---
async function main() {
    console.log('[*] 开始执行转换任务...');
    fs.mkdirSync(CONFIG.OUTPUT_DIR, { recursive: true });

    let pluginUrls = [];
    try {
        pluginUrls = await getPluginUrlList();          // 优先 API
    } catch (apiError) {
        console.warn(`[!] GitHub API 获取失败: ${apiError.message}。尝试本地扫描模式...`);
        pluginUrls = getLocalPluginList();
    }

    if (pluginUrls.length === 0) {
        console.log('[!] 未找到任何 .lpx 插件。');
        if (process.env.GITHUB_OUTPUT) {
            fs.appendFileSync(process.env.GITHUB_OUTPUT, `files_converted=false\n`);
        }
        return;
    }

    console.log(`[*] 共 ${pluginUrls.length} 个插件，并发数 ${CONFIG.CONCURRENCY}，开始转换...`);
    console.log("--------------------------------------------------");

    const limit = pLimit(CONFIG.CONCURRENCY);
    const tasks = pluginUrls.map(url => limit(() => convertSinglePlugin(url)));
    const results = await Promise.allSettled(tasks);

    let successCount = 0;
    results.forEach((result, index) => {
        const url = pluginUrls[index];
        const name = url.startsWith('http') ? path.basename(url) : path.basename(url);
        if (result.status === 'fulfilled') {
            console.log(`[+] 成功: ${name}`);
            successCount++;
        } else {
            console.error(`[!] 失败: ${name} -> ${result.reason.message}`);
        }
    });

    console.log("--------------------------------------------------");
    console.log(`[*] 完成。成功: ${successCount}, 失败: ${pluginUrls.length - successCount}`);

    if (process.env.GITHUB_OUTPUT) {
        fs.appendFileSync(process.env.GITHUB_OUTPUT, `files_converted=${successCount > 0}\n`);
        fs.appendFileSync(process.env.GITHUB_OUTPUT, `converted_count=${successCount}\n`);
    }
}

// --- 策略 A：从 GitHub API 获取列表 ---
async function getPluginUrlList() {
    const ref = process.env.REPO_REF || 'main';
    const apiUrl = `${CONFIG.REPO_API_URL}?ref=${ref}`;
    console.log(`[*] 调用 API: ${apiUrl}`);
    const headers = {
        'User-Agent': 'GitHub-Action-Node-Converter',
        'Authorization': `Bearer ${process.env.GITHUB_TOKEN}`
    };
    const responseText = await downloadContent(apiUrl, headers);
    const data = JSON.parse(responseText);

    if (!Array.isArray(data)) {
        throw new Error(data.message || 'API 返回格式错误');
    }
    return data
        .filter(item => item.name && item.name.endsWith('.lpx'))
        .map(item => item.download_url);
}

// --- 策略 B：扫描本地 Tools/Plugin 目录（降级）---
function getLocalPluginList() {
    const dir = CONFIG.LOCAL_PLUGIN_DIR;
    if (!fs.existsSync(dir)) {
        console.error(`[!] 本地插件目录不存在: ${dir}`);
        return [];
    }
    console.log(`[*] 扫描本地目录: ${dir}`);
    return fs.readdirSync(dir)
        .filter(f => f.endsWith('.lpx'))
        .map(f => path.join(dir, f));
}

// --- 转换单个插件（核心）---
function convertSinglePlugin(pluginSource) {
    const rewriteParserPath = path.join(CONFIG.SCRIPT_HUB_PATH, 'Rewrite-Parser.js');
    if (!fs.existsSync(rewriteParserPath)) {
        throw new Error(`未找到转换脚本: ${rewriteParserPath}`);
    }

    return new Promise(async (resolve, reject) => {
        let settled = false;
        const timeout = setTimeout(() => {
            if (!settled) {
                settled = true;
                reject(new Error(`转换超时 (${CONFIG.TIMEOUT_MS/1000}s)`));
            }
        }, CONFIG.TIMEOUT_MS);

        try {
            let content, filename;
            if (pluginSource.startsWith('http')) {
                content = await downloadContent(pluginSource, { 'User-Agent': 'GitHub-Action-Node-Converter' });
                filename = path.basename(pluginSource, '.lpx');
            } else {
                content = fs.readFileSync(pluginSource, 'utf8');
                filename = path.basename(pluginSource, '.lpx');
            }

            const outputPath = path.join(CONFIG.OUTPUT_DIR, `${filename}.sgmodule`);

            // 模拟环境
            const $request = { url: `https://script.hub/file/_start_/${encodeURIComponent(pluginSource)}/_end_/${filename}.sgmodule?type=loon-plugin&target=surge-module` };
            const $httpClient = { get: (req, cb) => cb(null, { statusCode: 200, headers: {} }, content) };
            const $notification = { post: () => {} };
            const $arguments = {};
            const $env = {};

            const $done = (response) => {
                if (settled) return;
                settled = true;
                clearTimeout(timeout);
                const body = response?.body || response?.response?.body;
                if (!body) {
                    reject(new Error('转换结果 body 为空'));
                    return;
                }
                // 解码 argument 参数
                const finalBody = body.replace(/argument=([^\n\r]+)/g, (_, match) => {
                    try {
                        return match.includes('%') ? 'argument=' + decodeURIComponent(match) : 'argument=' + match;
                    } catch { return 'argument=' + match; }
                });
                fs.writeFileSync(outputPath, finalBody, 'utf8');
                resolve(outputPath);
            };

            const scriptContent = fs.readFileSync(rewriteParserPath, 'utf8');
            const runScript = new Function('$request', '$done', '$httpClient', '$notification', '$arguments', '$env', 'https', scriptContent);
            runScript($request, $done, $httpClient, $notification, $arguments, $env, https);

        } catch (err) {
            if (!settled) {
                settled = true;
                clearTimeout(timeout);
                reject(err);
            }
        }
    });
}

// --- 通用 HTTP GET (支持重定向) ---
function downloadContent(url, headers = {}) {
    return new Promise((resolve, reject) => {
        https.get(url, { headers }, (res) => {
            if (res.statusCode < 200 || res.statusCode >= 300) {
                return reject(new Error(`HTTP ${res.statusCode} @ ${url}`));
            }
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve(data));
        }).on('error', reject);
    });
}

main().catch(err => {
    console.error('[!] 致命错误:', err.message);
    process.exit(1);
});
