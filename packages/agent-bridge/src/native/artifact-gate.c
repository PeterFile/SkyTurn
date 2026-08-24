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

#define MAX_PUBLICATION_BYTES (32U * 1024U * 1024U)

static int valid_relative_path(const char *path) {
  if (path == NULL || path[0] == '\0' || path[0] == '/') return 0;
  const char *component = path;
  for (const unsigned char *cursor = (const unsigned char *)path;; cursor += 1) {
    if (*cursor != '\0' && *cursor != '/') {
      if (*cursor < 0x20 || *cursor == 0x7f) return 0;
      continue;
    }
    size_t length = (size_t)((const char *)cursor - component);
    if (length == 0 || (length == 1 && component[0] == '.') ||
        (length == 2 && component[0] == '.' && component[1] == '.')) {
      return 0;
    }
    if (*cursor == '\0') return 1;
    component = (const char *)cursor + 1;
  }
}

static int open_directory_components(int parent, char *path, int create_missing) {
  char *state = NULL;
  char *component = strtok_r(path, "/", &state);
  int current = dup(parent);
  if (current < 0) return -1;
  while (component != NULL) {
    int next = openat(current, component, O_RDONLY | O_CLOEXEC | O_DIRECTORY | O_NOFOLLOW);
    int created = 0;
    if (next < 0 && create_missing && errno == ENOENT) {
      if (mkdirat(current, component, 0700) == 0) {
        created = 1;
      } else if (errno != EEXIST) {
        close(current);
        return -1;
      }
      next = openat(current, component, O_RDONLY | O_CLOEXEC | O_DIRECTORY | O_NOFOLLOW);
    }
    if (next < 0) {
      close(current);
      return -1;
    }
    struct stat directory;
    if (fstat(next, &directory) != 0 || !S_ISDIR(directory.st_mode)) {
      close(current);
      close(next);
      errno = ENOTDIR;
      return -1;
    }
    if (created && (fsync(next) != 0 || fsync(current) != 0)) {
      close(current);
      close(next);
      return -1;
    }
    close(current);
    current = next;
    component = strtok_r(NULL, "/", &state);
  }
  return current;
}

static void print_error(void) {
  printf("RESULT %s\n", errno == ENOENT ? "missing" : "unsafe");
}

static int write_all(int fd, const unsigned char *buffer, size_t length) {
  size_t offset = 0;
  while (offset < length) {
    ssize_t written = write(fd, buffer + offset, length - offset);
    if (written < 0 && errno == EINTR) continue;
    if (written <= 0) return -1;
    offset += (size_t)written;
  }
  return 0;
}

static int publish_artifact(int worktree_fd, const char *artifact_path) {
  char *relative = strdup(artifact_path);
  if (relative == NULL) return 70;
  char *filename = strrchr(relative, '/');
  if (filename == NULL || filename[1] == '\0') {
    free(relative);
    return 64;
  }
  *filename = '\0';
  filename += 1;

  int parent_fd = open_directory_components(worktree_fd, relative, 1);
  if (parent_fd < 0) {
    free(relative);
    puts("RESULT unsafe");
    return 0;
  }

  char temporary[96];
  int temporary_fd = -1;
  int temporary_exists = 0;
  for (unsigned int attempt = 0; attempt < 64; attempt += 1) {
    int length = snprintf(temporary, sizeof(temporary), ".skyturn-artifact-%ld-%u.tmp",
                          (long)getpid(), attempt);
    if (length < 0 || (size_t)length >= sizeof(temporary)) break;
    temporary_fd = openat(parent_fd, temporary,
                          O_WRONLY | O_CLOEXEC | O_CREAT | O_EXCL | O_NOFOLLOW, 0600);
    if (temporary_fd >= 0) {
      temporary_exists = 1;
      break;
    }
    if (errno != EEXIST) break;
  }

  int published = 0;
  size_t total = 0;
  if (temporary_fd >= 0) {
    struct stat temporary_stat;
    if (fstat(temporary_fd, &temporary_stat) == 0 && S_ISREG(temporary_stat.st_mode)) {
      unsigned char buffer[64 * 1024];
      for (;;) {
        ssize_t received = read(STDIN_FILENO, buffer, sizeof(buffer));
        if (received < 0 && errno == EINTR) continue;
        if (received < 0) break;
        if (received == 0) {
          if (total > 0 && fsync(temporary_fd) == 0 && close(temporary_fd) == 0) {
            temporary_fd = -1;
            struct stat target;
            int target_safe = 0;
            if (fstatat(parent_fd, filename, &target, AT_SYMLINK_NOFOLLOW) == 0) {
              target_safe = S_ISREG(target.st_mode);
            } else if (errno == ENOENT) {
              target_safe = 1;
            }
            if (target_safe) {
              if (renameat(parent_fd, temporary, parent_fd, filename) == 0) {
                temporary_exists = 0;
                if (fsync(parent_fd) == 0) published = 1;
              }
            }
          }
          break;
        }
        if ((size_t)received > MAX_PUBLICATION_BYTES - total ||
            write_all(temporary_fd, buffer, (size_t)received) != 0) {
          break;
        }
        total += (size_t)received;
      }
    }
  }

  if (temporary_fd >= 0) close(temporary_fd);
  if (temporary_exists) unlinkat(parent_fd, temporary, 0);
  close(parent_fd);
  free(relative);
  puts(published ? "RESULT published" : "RESULT unsafe");
  return 0;
}

static int inspect_artifact(int worktree_fd, const char *artifact_path) {
  char *relative = strdup(artifact_path);
  if (relative == NULL) return 70;

  char *filename = strrchr(relative, '/');
  if (filename == NULL || filename[1] == '\0') {
    free(relative);
    return 64;
  }
  *filename = '\0';
  filename += 1;
  int parent_fd = open_directory_components(worktree_fd, relative, 0);
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

int main(int argc, char **argv) {
  int write_mode = argc == 3 && strcmp(argv[1], "write") == 0;
  const char *artifact_path = write_mode ? argv[2] : argc == 2 ? argv[1] : NULL;
  if (!valid_relative_path(artifact_path)) return 64;

  struct stat worktree;
  if (fstat(3, &worktree) != 0 || !S_ISDIR(worktree.st_mode)) return 70;
  return write_mode
    ? publish_artifact(3, artifact_path)
    : inspect_artifact(3, artifact_path);
}
