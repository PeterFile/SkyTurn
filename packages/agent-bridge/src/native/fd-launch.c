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

  int executable_index = 0;
  int require_git_metadata = 0;
  int preserve_worktree_fd = 0;
  for (int index = 1; index < argc; index += 1) {
    if (argv[index] == NULL) {
      return fail("invalid launcher", 64);
    }
    if (argv[index][0] != '-') {
      executable_index = index;
      break;
    }
    if (strcmp(argv[index], "--require-git") == 0) {
      if (require_git_metadata) return fail("duplicate --require-git", 64);
      require_git_metadata = 1;
      continue;
    }
    if (strcmp(argv[index], "--preserve-worktree-fd") == 0) {
      if (preserve_worktree_fd) return fail("duplicate --preserve-worktree-fd", 64);
      preserve_worktree_fd = 1;
      continue;
    }
    return fail("invalid option", 64);
  }
  if (executable_index == 0 || argc <= executable_index || argv[executable_index] == NULL || argv[executable_index][0] != '/') {
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

  int next_descriptor_flags = preserve_worktree_fd
    ? (descriptor_flags & ~FD_CLOEXEC)
    : (descriptor_flags | FD_CLOEXEC);
  if (fcntl(SKYTURN_WORKTREE_FD, F_SETFD, next_descriptor_flags) != 0) {
    return fail(
      preserve_worktree_fd ? "cannot preserve worktree descriptor" : "cannot protect worktree descriptor",
      66
    );
  }

  execv(argv[executable_index], &argv[executable_index]);
  return fail("cannot execute launcher", errno == ENOENT ? 127 : 126);
}
