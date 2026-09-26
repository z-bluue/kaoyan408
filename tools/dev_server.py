#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""本地开发用的静态服务器：给所有响应加 no-store，避免浏览器拿磁盘缓存的旧 JS。

python -m http.server 不发 Cache-Control，浏览器会启发式缓存，
改完 js/css 后普通刷新可能还在跑旧文件，非常容易误判"改动没生效"。

    C:/Python314/python.exe tools/dev_server.py           # 默认 8080
    C:/Python314/python.exe tools/dev_server.py 8081
"""

import functools
import http.server
import os
import socketserver
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, must-revalidate')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

    def log_message(self, fmt, *args):        # 输出精简一点
        if 'GET' in fmt % args:
            sys.stderr.write("%s\n" % (fmt % args))


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    handler = functools.partial(NoCacheHandler, directory=ROOT)
    socketserver.ThreadingTCPServer.allow_reuse_address = True
    with socketserver.ThreadingTCPServer(('127.0.0.1', port), handler) as httpd:
        print(f'开发服务器（no-store）: http://127.0.0.1:{port}/  目录 {ROOT}')
        httpd.serve_forever()


if __name__ == '__main__':
    main()
