# script/lpx.py

import os
import re
import time
import json
import hashlib
import logging
from urllib.parse import unquote, urlparse
from curl_cffi import requests
import concurrent.futures
import random
import sqlite3
from datetime import datetime

# === 配置信息 ===
HEADERS = {
    "User-Agent": "Surge iOS/9515",
    "Accept": "application/json",
    "Accept-Language": "zh-CN,zh;q=0.9",
    "Referer": "https://kelee.one/",
    "Connection": "keep-alive"
}
JSON_URL = "https://pluginhub.kelee.one/list.json"
OUTPUT_DIR = "Plugin"
MAX_RETRIES = 3             # 最大重试次数
INITIAL_SLEEP = 1           # 初始重试间隔(秒)
MAX_SLEEP = 10              # 最大重试间隔(秒)
TIMEOUT = 30                # 请求超时(秒)
MAX_WORKERS = 8             # 最大并发线程数
PLUGIN_REGEX = re.compile(r"loon://import\?plugin=(https?://[^\s]+)")
DB_FILE = "plugin_versions.db"  # 版本数据库文件

# --- 配置日志系统 ---
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S"
)
logger = logging.getLogger(__name__)

# --- 数据库操作函数 ---

def init_database():
    """初始化版本数据库，如果表不存在则创建。"""
    conn = sqlite3.connect(DB_FILE)
    cursor = conn.cursor()
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS plugins (
            url TEXT PRIMARY KEY,
            filename TEXT,
            last_modified TEXT,
            etag TEXT,
            file_hash TEXT,
            last_checked TEXT
        )
    ''')
    conn.commit()
    conn.close()

def get_plugin_info(url):
    """从数据库获取指定URL的插件版本信息。"""
    conn = sqlite3.connect(DB_FILE)
    cursor = conn.cursor()
    cursor.execute("SELECT filename, last_modified, etag, file_hash FROM plugins WHERE url = ?", (url,))
    result = cursor.fetchone()
    conn.close()
    
    if result:
        return {
            "filename": result[0],
            "last_modified": result[1],
            "etag": result[2],
            "file_hash": result[3]
        }
    return None

def update_plugin_info(url, filename, last_modified, etag, file_hash):
    """向数据库中插入或更新插件的版本信息。"""
    now = datetime.now().isoformat()
    conn = sqlite3.connect(DB_FILE)
    cursor = conn.cursor()
    cursor.execute('''
        INSERT OR REPLACE INTO plugins 
        (url, filename, last_modified, etag, file_hash, last_checked) 
        VALUES (?, ?, ?, ?, ?, ?)
    ''', (url, filename, last_modified, etag, file_hash, now))
    conn.commit()
    conn.close()

# --- 核心逻辑函数 ---

def extract_plugin_urls_from_json(data):
    """从JSON数据中灵活地提取所有插件的URL。"""
    urls = []
    
    # 尝试从不同结构位置提取插件列表
    plugin_list = []
    if isinstance(data, dict):
        if "lists" in data and isinstance(data["lists"], list):
            plugin_list = data["lists"]
            logger.info("📦 从 'lists' 字段提取插件列表")
        elif "plugins" in data and isinstance(data["plugins"], list):
            plugin_list = data["plugins"]
            logger.info("📦 从 'plugins' 字段提取插件列表")
    elif isinstance(data, list):
        plugin_list = data
    
    if not plugin_list:
        logger.error("❌ 未找到有效的插件列表字段")
        return []
        
    for item in plugin_list:
        try:
            if not isinstance(item, dict):
                continue
            
            # 尝试多种可能的URL字段
            url_field = item.get("url") or item.get("plugin") or item.get("link")
            if not url_field or not isinstance(url_field, str):
                continue
            
            # 使用正则表达式从 'loon://' 协议中提取真实的HTTP URL
            if match := PLUGIN_REGEX.search(url_field):
                plugin_url = unquote(match.group(1))
                urls.append(plugin_url)
        except Exception as e:
            logger.warning(f"解析条目时出错: {item}, 错误: {e}")
            
    return list(set(urls))  # 返回去重后的URL列表

def calculate_file_hash(file_path):
    """计算文件的SHA-256哈希值，用于精确比较文件内容。"""
    sha256 = hashlib.sha256()
    try:
        with open(file_path, "rb") as f:
            while chunk := f.read(8192):
                sha256.update(chunk)
        return sha256.hexdigest()
    except IOError as e:
        logger.error(f"计算文件哈希时出错: {e}")
        return None

def download_file_with_retry(url):
    """带重试机制和版本检查的文件下载函数。"""
    filename = os.path.basename(urlparse(url).path)
    output_path = os.path.join(OUTPUT_DIR, filename)
    
    # 从数据库获取已有的版本信息
    existing_info = get_plugin_info(url)
    
    # 准备条件请求头
    conditional_headers = HEADERS.copy()
    if existing_info:
        if etag := existing_info.get("etag"):
            conditional_headers["If-None-Match"] = etag
        if last_modified := existing_info.get("last_modified"):
            conditional_headers["If-Modified-Since"] = last_modified
            
    # 指数退避重试策略
    sleep_time = INITIAL_SLEEP
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            response = requests.get(
                url,
                timeout=TIMEOUT,
                impersonate="chrome120",  # 使用具体的浏览器版本
                headers=conditional_headers
            )
            
            # 处理304 Not Modified: 文件未变化
            if response.status_code == 304:
                # 检查文件是否存在且有效
                if os.path.exists(output_path) and os.path.getsize(output_path) > 0:
                    logger.info(f"[{filename}] ✅ 文件未修改 (304)，跳过下载。")
                    return "skipped", filename
                else:
                    logger.warning(f"[{filename}] ⚠️ 文件未修改但本地文件丢失或无效，重新下载")
                    # 清除条件头，强制重新下载
                    conditional_headers.pop("If-None-Match", None)
                    conditional_headers.pop("If-Modified-Since", None)
                    continue
            
            # 处理200 OK: 下载新文件
            if response.status_code == 200:
                with open(output_path, "wb") as f:
                    f.write(response.content)
                
                # 验证文件完整性
                if os.path.getsize(output_path) == 0:
                    logger.warning(f"[{filename}] ⚠️ 下载文件为空，重试中...")
                    os.remove(output_path)
                    raise Exception("Empty file downloaded")
                
                new_etag = response.headers.get("ETag")
                new_last_modified = response.headers.get("Last-Modified")
                file_hash = calculate_file_hash(output_path)
                
                # 更新数据库中的版本信息
                update_plugin_info(url, filename, new_last_modified, new_etag, file_hash)
                
                logger.info(f"[{filename}] ✅ 下载/更新成功 (尝试 {attempt} 次)")
                return "success", filename

            # 处理其他错误状态码
            logger.warning(f"[{filename}] ⚠️ 状态码异常: {response.status_code} (尝试 {attempt}/{MAX_RETRIES})")
            # 特殊处理404错误
            if response.status_code == 404:
                logger.error(f"[{filename}] ❌ 资源不存在 (404)")
                return "failure", filename

        except Exception as e:
            logger.warning(f"[{filename}] 🔄 请求异常: {e} (尝试 {attempt}/{MAX_RETRIES})")
        
        # 指数退避 + 随机抖动
        if attempt < MAX_RETRIES:
            sleep_time = min(sleep_time * 2, MAX_SLEEP) * (0.8 + 0.4 * random.random())
            logger.info(f"[{filename}] ⏳ 等待 {sleep_time:.1f} 秒后重试...")
            time.sleep(sleep_time)
            
    logger.error(f"[{filename}] ❌ 下载失败，已达最大重试次数。")
    return "failure", filename

def main():
    """主函数，负责协调整个下载流程。"""
    start_time = time.time()
    init_database()
    
    logger.info(f"🔍 正在从 JSON 获取插件列表: {JSON_URL}")
    try:
        response = requests.get(JSON_URL, headers=HEADERS, timeout=TIMEOUT, impersonate="chrome120")
        response.raise_for_status()
        data = response.json()
    except Exception as e:
        logger.error(f"❌ 获取或解析JSON失败: {e}")
        return

    urls = extract_plugin_urls_from_json(data)
    if not urls:
        logger.error("❌ 未能提取到任何下载链接。")
        return
    
    logger.info(f"✅ 成功提取 {len(urls)} 个插件链接，准备开始下载...")
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    
    # 使用并发下载
    results = {"success": 0, "skipped": 0, "failure": 0}
    with concurrent.futures.ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
        future_to_url = {executor.submit(download_file_with_retry, url): url for url in urls}
        for future in concurrent.futures.as_completed(future_to_url):
            try:
                status, _ = future.result()
                results[status] += 1
            except Exception as e:
                logger.error(f"处理下载结果时发生严重错误: {e}")
                results["failure"] += 1
    
    # 输出最终统计信息
    elapsed_time = time.time() - start_time
    total_files = sum(results.values())
    
    logger.info("=" * 50)
    logger.info("📊 下载任务完成")
    logger.info(f"   - 更新成功: {results['success']}")
    logger.info(f"   - 无需更新 (跳过): {results['skipped']}")
    logger.info(f"   - 下载失败: {results['failure']}")
    logger.info(f"⏱️ 总耗时: {elapsed_time:.2f} 秒")
    
    # 添加文件大小统计
    try:
        total_size = sum(os.path.getsize(os.path.join(OUTPUT_DIR, f)) 
                       for f in os.listdir(OUTPUT_DIR) 
                       if os.path.isfile(os.path.join(OUTPUT_DIR, f)))
        logger.info(f"💾 总文件大小: {total_size/1024:.2f} KB")
    except OSError as e:
        logger.warning(f"无法计算文件大小: {e}")
    
    logger.info("=" * 50)

if __name__ == "__main__":
    main()
