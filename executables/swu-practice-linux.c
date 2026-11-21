// SWU Practice — Linux click-to-run stub (Stage 8.1).
//
// A tiny statically-linked ELF that lives next to SWU-Practice.sh and
// execs it under /bin/bash, forwarding all arguments (so
// `SWU-Practice --stop` / `--status` work). Static linking means it
// runs on any x86-64 Linux regardless of distro or glibc version —
// the .sh and everything it starts were already portable; this just
// gives file managers a real program to double-click.
//
// When launched by clicking (stdout is not a terminal), stdout and
// stderr are appended to launcher.log next to the stub first, so a
// failed launch leaves a readable log instead of vanishing. From a
// terminal, output stays live.

#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <limits.h>
#include <fcntl.h>

int main(int argc, char **argv)
{
    static char exe[PATH_MAX];
    ssize_t n = readlink("/proc/self/exe", exe, sizeof(exe) - 1);
    if (n < 0) {
        perror("SWU-Practice: readlink /proc/self/exe");
        return 1;
    }
    exe[n] = '\0';

    char *slash = strrchr(exe, '/');
    if (!slash)
        return 1;
    *slash = '\0'; /* exe now holds the stub's own directory */

    static char script[PATH_MAX];
    if (snprintf(script, sizeof(script), "%s/SWU-Practice.sh", exe)
            >= (int)sizeof(script))
        return 1;

    if (!isatty(STDOUT_FILENO)) {
        static char logpath[PATH_MAX];
        if (snprintf(logpath, sizeof(logpath), "%s/launcher.log", exe)
                < (int)sizeof(logpath)) {
            int fd = open(logpath, O_WRONLY | O_CREAT | O_APPEND, 0644);
            if (fd >= 0) {
                dup2(fd, STDOUT_FILENO);
                dup2(fd, STDERR_FILENO);
                if (fd > STDERR_FILENO)
                    close(fd);
            }
        }
    }

    char **newargv = malloc(sizeof(char *) * (size_t)(argc + 2));
    if (!newargv)
        return 1;
    newargv[0] = "/bin/bash";
    newargv[1] = script;
    for (int i = 1; i < argc; i++)
        newargv[i + 1] = argv[i];
    newargv[argc + 1] = NULL;

    execv("/bin/bash", newargv);
    perror("SWU-Practice: exec /bin/bash");
    return 1;
}
