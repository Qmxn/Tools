import requests
import re
import os
import time
from urllib.parse import urlparse

README_URL = "https://raw.githubusercontent.com/luestr/ProxyResource/refs/heads/main/README.md"
LOCAL_README = "README.md"
OUTPUT_DIR = "Loon/Plugin"
BASE_PATH = "https://kelee.one/Tool/Loon/"

HEADERS = {
    "User-Agent": "Surge iOS/9527",
    "Accept": "*/*",
    "Accept-Language": "zh-CN,zh;q=0.9",
    "Referer": "https://kelee.one/",
    "Connection": "keep-alive"
}

# 提取 plugin=xxx.lpx 和标题
REWRITE_PATTERN = re.compile(
    r'<td><a href="https://www\.nsloon\.com/openloon/import\?plugin=([^"]+)">([^<]+)</a></td>'
)

def download_readme():
    response = requests.get(README_URL, timeout=10)
    response.raise_for_status()
    with open(LOCAL_README, "w", encoding="utf-8") as f:
        f.write(response.text)
    print("✅ README.md 下载成功")

def extract_links():
    results = []
    with open(LOCAL_README, "r", encoding="utf-8") as f:
        for line in f:
            match = REWRITE_PATTERN.search(line)
            if match:
                plugin_url = match.group(1)
                results.append(plugin_url)
    return results

def extract_filename_from_url(url):
    """从 URL 中提取文件名部分，例如 https://.../abc.lpx -> abc.lpx"""
    parsed = urlparse(url)
    return os.path.basename(parsed.path)

def download_lpx(links):
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    failed = []

    for plugin_val in links:
        url = plugin_val if plugin_val.startswith("http") else BASE_PATH + plugin_val
        filename = extract_filename_from_url(url)
        save_path = os.path.join(OUTPUT_DIR, filename)

        try:
            r = requests.get(url, headers=HEADERS, timeout=10)
            if r.status_code == 200:
                with open(save_path, "w", encoding="utf-8") as f:
                    f.write(r.text)
                print(f"✅ 文件已保存为 {save_path}")
            else:
                print(f"❌ 下载失败：{filename}，状态码: {r.status_code}")
                failed.append((filename, url, str(r.status_code)))
        except Exception as e:
            print(f"❌ 请求异常：{filename}，错误: {e}")
            failed.append((filename, url, "Exception"))

        time.sleep(1)

    if failed:
        with open("failed.txt", "w", encoding="utf-8") as f:
            for name, url, status in failed:
                f.write(f"{name}\t{url}\t{status}\n")
        print(f"\n⚠️ 共 {len(failed)} 个文件下载失败，详情见 failed.txt")

def main():
    download_readme()
    links = extract_links()
    print(f"共提取到 {len(links)} 个插件链接")
    download_lpx(links)

if __name__ == "__main__":
    main()
