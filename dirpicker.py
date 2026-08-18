#!/usr/bin/env python3
"""フォルダ選択ダイアログを開き、選ばれたパスを標準出力に返す小さなスクリプト。

server.py から別プロセスとして呼ばれる。ブラウザは仕様上、選んだフォルダの
絶対パスをページに渡してくれない（`<input type="file">`でもディレクトリ名までしか
取れない）ので、パスの取得はサーバー側で行う必要がある。

Tkはスレッドセーフではなく、HTTPサーバーのワーカースレッドから開くと
サーバーごと巻き添えで落ちうる。プロセスを分けて隔離しているのはそのため。
"""
import sys
import tkinter
from tkinter import filedialog


def main():
    initial = sys.argv[1] if len(sys.argv) > 1 else ""

    root = tkinter.Tk()
    root.withdraw()
    # ブラウザウィンドウの後ろに出ると気づけないので、最前面に固定する。
    root.attributes("-topmost", True)

    path = filedialog.askdirectory(
        title="プロジェクトのフォルダを選択",
        initialdir=initial or None,
        mustexist=True,
        parent=root,
    )
    root.destroy()

    # キャンセル時は空文字。呼び出し側は「出力なし」で判別する。
    if path:
        sys.stdout.write(path)


if __name__ == "__main__":
    main()
