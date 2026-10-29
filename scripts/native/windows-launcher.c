#include <windows.h>
#include <process.h>
#include <wchar.h>
#include <stdio.h>
#include <stdlib.h>

static wchar_t *quote_argument(const wchar_t *value) {
    wchar_t *result = malloc((wcslen(value) * 2 + 3) * sizeof(wchar_t));
    if (!result) return NULL;
    wchar_t *out = result;
    *out++ = L'"';
    size_t slashes = 0;
    for (const wchar_t *in = value; ; in++) {
        if (*in == L'\\') { slashes++; continue; }
        size_t count = (*in == L'"' || *in == 0) ? slashes * 2 : slashes;
        while (count--) *out++ = L'\\';
        slashes = 0;
        if (*in == 0) break;
        if (*in == L'"') *out++ = L'\\';
        *out++ = *in;
    }
    *out++ = L'"';
    *out = 0;
    return result;
}

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
    int ruby = wcscmp(name, L"ruby") == 0;
    int direct_python = wcscmp(name, L"python3") == 0;
    if (ruby) {
        swprintf_s(python, 32768, L"%ls\\openstudio\\bin\\openstudio.exe", root);
        swprintf_s(script, 32768, L"%ls\\ruby-driver.rb", root);
    } else {
        swprintf_s(python, 32768, L"%ls\\python-runtime\\python.exe", root);
        swprintf_s(script, 32768, L"%ls\\launch.py", root);
    }
    int prefix = ruby || direct_python ? 2 : 4;
    int count = prefix + argc - 1;
    const wchar_t *prefix_args[] = { python, ruby ? script : L"-I", script, name };
    wchar_t **args = calloc((size_t)argc + 5, sizeof(wchar_t *));
    if (!args) return 1;
    for (int i = 0; i < count; i++) {
        const wchar_t *value = i < prefix ? prefix_args[i] : argv[i - prefix + 1];
        args[i] = quote_argument(value);
        if (!args[i]) {
            for (int j = 0; j < i; j++) free(args[j]);
            free(args);
            return 1;
        }
    }
    intptr_t status = _wspawnv(_P_WAIT, python, (const wchar_t *const *)args);
    for (int i = 0; i < count; i++) free(args[i]);
    free(args);
    if (status == -1) { _wperror(L"ChatStudio bundled launcher"); return 1; }
    return (int)status;
}
