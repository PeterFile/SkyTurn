#define _DARWIN_C_SOURCE
#define _GNU_SOURCE
#define _POSIX_C_SOURCE 200809L

#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#ifndef O_DIRECTORY
#define O_DIRECTORY 0
#endif

#ifndef O_NOFOLLOW
#error "O_NOFOLLOW is required"
#endif

static int open_directory_components(int parent, char *path) {
  char *component = strtok(path, "/");
  int current = dup(parent);
  if (current < 0) return -1;
  while (component != NULL) {
    int next = openat(current, component, O_RDONLY | O_CLOEXEC | O_DIRECTORY | O_NOFOLLOW);
    close(current);
    if (next < 0) return -1;
    struct stat directory;
    if (fstat(next, &directory) != 0 || !S_ISDIR(directory.st_mode)) {
      close(next);
      errno = ENOTDIR;
      return -1;
    }
    current = next;
    component = strtok(NULL, "/");
  }
  return current;
}

static void print_error(void) {
  printf("RESULT %s\n", errno == ENOENT ? "missing" : "unsafe");
}

int main(int argc, char **argv) {
  if (argc != 2 || argv[1][0] == '/') return 64;

  struct stat worktree;
  if (fstat(3, &worktree) != 0 || !S_ISDIR(worktree.st_mode)) return 70;
  char *relative = strdup(argv[1]);
  if (relative == NULL) return 70;

  char *filename = strrchr(relative, '/');
  if (filename == NULL || filename[1] == '\0') return 64;
  *filename = '\0';
  filename += 1;
  int parent_fd = open_directory_components(3, relative);
  if (parent_fd < 0) {
    print_error();
    free(relative);
    return 0;
  }

  puts("READY");
  fflush(stdout);
  if (getchar() == EOF) {
    close(parent_fd);
    free(relative);
    return 74;
  }

  int artifact_fd = openat(parent_fd, filename, O_RDONLY | O_CLOEXEC | O_NONBLOCK | O_NOFOLLOW);
  close(parent_fd);
  free(relative);
  if (artifact_fd < 0) {
    print_error();
    return 0;
  }

  puts("OPENED");
  fflush(stdout);
  if (getchar() == EOF) {
    close(artifact_fd);
    return 74;
  }

  struct stat artifact;
  if (fstat(artifact_fd, &artifact) != 0) {
    close(artifact_fd);
    puts("RESULT unsafe");
    return 0;
  }
  if (!S_ISREG(artifact.st_mode)) {
    close(artifact_fd);
    printf("RESULT unsafe %llu:%llu\n", (unsigned long long)artifact.st_dev, (unsigned long long)artifact.st_ino);
    return 0;
  }
  unsigned char byte;
  ssize_t bytes_read = read(artifact_fd, &byte, 1);
  if (bytes_read < 0) {
    close(artifact_fd);
    puts("RESULT unsafe");
    return 0;
  }
  close(artifact_fd);
  printf("RESULT %s %llu:%llu\n", bytes_read > 0 && artifact.st_size > 0 ? "present" : "empty",
         (unsigned long long)artifact.st_dev, (unsigned long long)artifact.st_ino);
  return 0;
}
