"""知识库工作台 · Python 运行时

- 零第三方依赖即可运行（可选安装 cryptography 以启用与 Node 版兼容的 AES-256-GCM）
- 对外提供：HTTP 服务（本地 / 网页同源）、MCP 服务端、命令行同步
"""

from .core import CONFIG, VERSION, crypto_mode
from .store import Store, create_store

__all__ = ["CONFIG", "VERSION", "crypto_mode", "Store", "create_store"]
__version__ = VERSION
