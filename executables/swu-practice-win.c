// SWU Practice — Windows click-to-run stub (Stage 8.1).
//
// A tiny statically-linked .exe that lives next to SWU-Practice.ps1 and
// launches it with PowerShell, forwarding any command-line arguments
// (so SWU-Practice.exe -Stop / -Status work). It exists so the Windows
// package has a real double-clickable program instead of only a .bat.
// The PowerShell console stays visible — that progress output is the
// feedback, same as the Mac Terminal flow.

#include <windows.h>
#include <stdio.h>
#include <string.h>
#include <stdlib.h>

int main(void)
{
    static char dir[MAX_PATH * 2];
    static char cmd[32768];

    DWORD n = GetModuleFileNameA(NULL, dir, sizeof(dir));
    if (n == 0 || n >= sizeof(dir))
        return 1;

    /* Strip the file name, leaving the exe's own directory. */
    char *slash = strrchr(dir, '\\');
    if (slash)
        *slash = '\0';
    else
        return 1;

    /* The remainder of our own command line (everything after the
       program name) is forwarded verbatim. The program name may be
       quoted or bare; handle both. */
    char *rest = GetCommandLineA();
    if (*rest == '"') {
        rest++;
        while (*rest && *rest != '"')
            rest++;
        if (*rest == '"')
            rest++;
    } else {
        while (*rest && *rest != ' ' && *rest != '\t')
            rest++;
    }
    while (*rest == ' ' || *rest == '\t')
        rest++;

    /* One format literal: the script name stays a plain contiguous
       string in the binary (no strcat for the compiler to dissolve
       into immediate-value stores). */
    int w = snprintf(cmd, sizeof(cmd),
                     "powershell.exe -NoProfile -ExecutionPolicy Bypass "
                     "-File \"%s\\SWU-Practice.ps1\"%s%s",
                     dir, *rest ? " " : "", rest);
    if (w < 0 || (size_t)w >= sizeof(cmd))
        return 1;

    STARTUPINFOA si;
    PROCESS_INFORMATION pi;
    ZeroMemory(&si, sizeof(si));
    si.cb = sizeof(si);
    ZeroMemory(&pi, sizeof(pi));

    if (!CreateProcessA(NULL, cmd, NULL, NULL, TRUE, 0, NULL, dir, &si, &pi))
        return 1;

    WaitForSingleObject(pi.hProcess, INFINITE);
    DWORD code = 1;
    GetExitCodeProcess(pi.hProcess, &code);
    CloseHandle(pi.hProcess);
    CloseHandle(pi.hThread);
    return (int)code;
}
