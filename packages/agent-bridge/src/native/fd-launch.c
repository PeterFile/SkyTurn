#define _POSIX_C_SOURCE 200809L

#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#define SKYTURN_WORKTREE_FD 3
#define SKYTURN_STATUS_FD 4

static int fail(const char *message, int status) {
  ssize_t written;
  do {
    written = write(SKYTURN_STATUS_FD, "F", 1);
  } while (written < 0 && errno == EINTR);
  (void)fprintf(stderr, "skyturn-fd-launch: %s\n", message);
  return status;
}

int main(int argc, char *argv[]) {
  int status_flags = fcntl(SKYTURN_STATUS_FD, F_GETFD);
  if (status_flags < 0 || fcntl(SKYTURN_STATUS_FD, F_SETFD, status_flags | FD_CLOEXEC) != 0) {
    return fail("invalid status descriptor", 65);
  }

  int executable_index = 1;
  int require_git_metadata = 0;
  if (argc > 1 && argv[1] != NULL && strcmp(argv[1], "--require-git") == 0) {
    require_git_metadata = 1;
    executable_index = 2;
  }
  if (argc <= executable_index || argv[executable_index] == NULL || argv[executable_index][0] != '/') {
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

  if (require_git_metadata) {
    struct stat git_metadata;
    if (
      fstatat(SKYTURN_WORKTREE_FD, ".git", &git_metadata, AT_SYMLINK_NOFOLLOW) != 0 ||
      (!S_ISDIR(git_metadata.st_mode) && !S_ISREG(git_metadata.st_mode))
    ) {
      return fail("worktree descriptor has no git metadata", 66);
    }
  }

  if (fchdir(SKYTURN_WORKTREE_FD) != 0) {
    return fail("cannot enter worktree descriptor", 66);
  }

  if (fcntl(SKYTURN_WORKTREE_FD, F_SETFD, descriptor_flags | FD_CLOEXEC) != 0) {
    return fail("cannot protect worktree descriptor", 66);
  }

  execv(argv[executable_index], &argv[executable_index]);
  return fail("cannot execute launcher", errno == ENOENT ? 127 : 126);
}
