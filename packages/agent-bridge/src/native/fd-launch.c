#define _POSIX_C_SOURCE 200809L

#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <sys/stat.h>
#include <unistd.h>

#define SKYTURN_WORKTREE_FD 3
#define SKYTURN_STATUS_FD 4

static int fail(const char *message, int status) {
  (void)write(SKYTURN_STATUS_FD, "F", 1);
  (void)fprintf(stderr, "skyturn-fd-launch: %s\n", message);
  return status;
}

int main(int argc, char *argv[]) {
  int status_flags = fcntl(SKYTURN_STATUS_FD, F_GETFD);
  if (status_flags < 0 || fcntl(SKYTURN_STATUS_FD, F_SETFD, status_flags | FD_CLOEXEC) != 0) {
    return fail("invalid status descriptor", 65);
  }

  if (argc < 2 || argv[1] == NULL || argv[1][0] != '/') {
    return fail("invalid launcher", 64);
  }

  int descriptor_flags = fcntl(SKYTURN_WORKTREE_FD, F_GETFD);
  if (descriptor_flags < 0) {
    return fail("invalid worktree descriptor", 65);
  }

  struct stat worktree;
  if (fstat(SKYTURN_WORKTREE_FD, &worktree) != 0 || !S_ISDIR(worktree.st_mode)) {
    return fail("worktree descriptor is not a directory", 65);
  }

  if (fchdir(SKYTURN_WORKTREE_FD) != 0) {
    return fail("cannot enter worktree descriptor", 66);
  }

  if (fcntl(SKYTURN_WORKTREE_FD, F_SETFD, descriptor_flags | FD_CLOEXEC) != 0) {
    return fail("cannot protect worktree descriptor", 66);
  }

  execv(argv[1], &argv[1]);
  return fail("cannot execute launcher", errno == ENOENT ? 127 : 126);
}
