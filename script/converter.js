const fs = require('fs');
const path = require('path');
const { https } = require('follow-redirects');

// --- 配置信息 ---
// 将配置项集中管理，方便修改
const CONFIG = {
    REPO_API_URL: "https://api.github.com/repos/Qmxn/Tools/contents/Plugin?ref=X",
    OUTPUT_DIR: "Modules",
    // 依赖的 Script-Hub 仓库信息
    SCRIPT_HUB_REPO: "Script-Hub-Org/Script-Hub",
    SCRIPT_HUB_PATH: "Script-Hub" // 本地克隆路径
};

// --- 主函数 ---
async function main() {
    console.log('[*] 开始执行转换任务...');

    const pluginUrls = await getPluginUrlList();
    if (pluginUrls.length === 0) {
        console.log('[!] 未找到任何 .lpx 文件。');
        if (process.env.GITHUB_OUTPUT) {
            fs.appendFileSync(process.env.GITHUB_OUTPUT, `files_converted=false\n`);
        }
        return;
    }

    console.log(`[*] 成功获取 ${pluginUrls.length} 个插件列表，准备并行转换。`);
    console.log("--------------------------------------------------");

    const conversionPromises = pluginUrls.map(url => convertSinglePlugin(url));
    const results = await Promise.allSettled(conversionPromises);

    let successCount = 0;
    results.forEach((result, index) => {
        const pluginUrl = pluginUrls[index];
        if (result.status === 'fulfilled') {
            console.log(`[+] 成功: ${path.basename(pluginUrl)}`);
            successCount++;
        } else {
            console.error(`[!] 失败: ${path.basename(pluginUrl)} - 原因: ${result.reason.message}`);
        }
    });

    console.log("--------------------------------------------------");
    console.log(`[*] 所有任务完成。成功: ${successCount}, 失败: ${pluginUrls.length - successCount}`);

    if (process.env.GITHUB_OUTPUT) {
        fs.appendFileSync(process.env.GITHUB_OUTPUT, `files_converted=${successCount > 0}\n`);
    }
}

// --- 获取插件列表 ---
async function getPluginUrlList() {
    console.log(`[*] 正在从 API 获取插件列表: ${CONFIG.REPO_API_URL}`);
    const headers = {
        'User-Agent': 'GitHub-Action-Node-Converter',
        'Authorization': `Bearer ${process.env.GITHUB_TOKEN}`
    };
    const responseText = await downloadContent(CONFIG.REPO_API_URL, headers);
    const responseJson = JSON.parse(responseText);

    if (responseJson.message) {
        throw new Error(`GitHub API 返回错误: ${responseJson.message}`);
    }

    return responseJson
        .filter(item => item.name && item.name.endsWith('.lpx'))
        .map(item => item.download_url);
}

// --- 转换单个插件（保留核心的 new Function 逻辑以保证转换质量） ---
function convertSinglePlugin(loonPluginUrl) {
    // 这个脚本的核心是利用 Script-Hub 的转换逻辑，所以必须确保其存在
    const rewriteParserPath = path.join(process.cwd(), CONFIG.SCRIPT_HUB_PATH, 'Rewrite-Parser.js');
    if (!fs.existsSync(rewriteParserPath)) {
        throw new Error(`未找到核心转换脚本: ${rewriteParserPath}。请确保工作流已克隆 ${CONFIG.SCRIPT_HUB_REPO} 仓库到 ${CONFIG.SCRIPT_HUB_PATH} 目录。`);
    }

    // 使用 Promise 包装，以便于 main 函数中的并行处理
    return new Promise(async (resolve, reject) => {
        try {
            const pluginContent = await downloadContent(loonPluginUrl, { 'User-Agent': 'GitHub-Action-Node-Converter' });
            const filename = path.basename(loonPluginUrl, '.lpx');
            const outputPath = path.join(CONFIG.OUTPUT_DIR, `${filename}.sgmodule`);
            fs.mkdirSync(CONFIG.OUTPUT_DIR, { recursive: true });

            // --- 模拟代理App环境 ---
            const $request = { url: `https://script.hub/file/_start_/${loonPluginUrl}/_end_/${path.basename(outputPath)}?type=loon-plugin&target=surge-module` };
            const $httpClient = { get: (req, cb) => cb(null, { statusCode: 200, headers: {} }, pluginContent) };
            const $notification = { post: () => {} };
            const $arguments = {};
            const $env = {};
            
            // 关键的 $done 函数，它负责接收转换结果并进行后处理
            const $done = (response) => {
                let body = response.body || (response.response && response.response.body);
                if (body) {
                    // [优化] 对转换结果进行增强，解码 argument 参数，提高可读性
                    body = body.replace(/argument=([^\n\r]+)/g, (_, match) => {
                        try {
                            // 只有包含编码特征的才解码
                            if (match.includes('%')) {
                                return 'argument=' + decodeURIComponent(match);
                            }
                        } catch { /* 解码失败则保持原样 */ }
                        return 'argument=' + match;
                    });
                    
                    fs.writeFileSync(outputPath, body, 'utf8');
                    resolve(outputPath);
                } else {
                    reject(new Error('转换脚本未返回有效内容'));
                }
            };
            
            // --- 执行外部脚本的核心（高风险，但保证高质量转换） ---
            // 读取社区维护的转换脚本内容
            const scriptContent = fs.readFileSync(rewriteParserPath, 'utf8');
            // 使用 new Function 在沙箱中执行，这是保证转换质量的关键
            const runScript = new Function('$request', '$done', '$httpClient', '$notification', '$arguments', '$env', 'https', scriptContent);
            runScript($request, $done, $httpClient, $notification, $arguments, $env, https);

        } catch (e) {
            reject(e);
        }
    });
}

// --- 通用下载函数 ---
function downloadContent(url, headers = {}) {
    return new Promise((resolve, reject) => {
        https.get(url, { headers }, (res) => {
            if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(`下载失败，状态码: ${res.statusCode} @ ${url}`));
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => resolve(data));
        }).on('error', (err) => reject(err));
    });
}

// --- 运行主程序 ---
main().catch(err => {
    console.error('[!] 发生致命错误:', err.message);
    process.exit(1);
});
