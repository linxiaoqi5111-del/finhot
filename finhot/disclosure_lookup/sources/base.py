"""Source 适配器协议：所有源实现同一接口，返回 DisclosureRecord 列表。

教学备注：用 typing.Protocol 定「鸭子类型」契约（结构化子类型，无需显式继承），
再配一个 BaseSource 提供默认属性 + 未实现占位。Protocol 适合「只要长得像就行」，
ABC 适合「强制继承体系」——这里两者都给，源类继承 BaseSource，类型上满足 Source。
"""
from __future__ import annotations

from typing import Optional, Protocol, runtime_checkable

from ..schema import DisclosureRecord


@runtime_checkable
class Source(Protocol):
    name: str
    authority: int

    def search_company(
        self, code: str, name: str = "", *, days: int = 30
    ) -> list[DisclosureRecord]:
        ...

    def search_keyword(
        self, keyword: str, *, days: int = 30, codes: Optional[list[str]] = None
    ) -> list[DisclosureRecord]:
        ...


class BaseSource:
    """具体源继承它：覆盖 name/authority 与两个查询方法。"""

    name: str = "base"
    authority: int = 0

    def search_company(
        self, code: str, name: str = "", *, days: int = 30
    ) -> list[DisclosureRecord]:
        raise NotImplementedError

    def search_keyword(
        self, keyword: str, *, days: int = 30, codes: Optional[list[str]] = None
    ) -> list[DisclosureRecord]:
        raise NotImplementedError
