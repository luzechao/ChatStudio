#include <windows.h>
#include <process.h>
#include <wchar.h>
#include <stdio.h>
#include <stdlib.h>

int wmain(int argc, wchar_t **argv) {
    wchar_t root[32768], python[32768], script[32768], name[64];
    if (!GetModuleFileNameW(NULL, root, 32768)) return 1;
    wchar_t *base = wcsrchr(root, L'\\');
    if (!base) return 1;
    wcsncpy_s(name, 64, base + 1, _TRUNCATE);
    wchar_t *extension = wcsrchr(name, L'.');
    if (extension) *extension = 0;
    *base = 0;
    base = wcsrchr(root, L'\\');
    if (!base) return 1;
    *base = 0;
    swprintf_s(python, 32768, L"%ls\\python-runtime\\python.exe", root);
    swprintf_s(script, 32768, L"%ls\\launch.py", root);
    const wchar_t **args = calloc((size_t)argc + 5, sizeof(wchar_t *));
    if (!args) return 1;
    args[0] = python; args[1] = L"-I"; args[2] = script; args[3] = name;
    for (int i = 1; i < argc; i++) args[i + 3] = argv[i];
    intptr_t status = _wspawnv(_P_WAIT, python, args);
    free(args);
    if (status == -1) { _wperror(L"ChatStudio bundled launcher"); return 1; }
    return (int)status;
}
