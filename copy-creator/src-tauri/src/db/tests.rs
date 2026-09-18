// db 领域测试集合：自 mod.rs 拆出，生产代码与测试分离。
// 各测试模块以 crate::db::* 引用领域项（子模块可见父模块私有项）。

#[cfg(test)]
mod key_preview_tests {
    use crate::db::make_key_preview;

    // 原实现对非 ASCII 内容按字节切片会 panic（字节 8 落入多字节字符内部），
    // 且 panic 点位于采集线程与持锁的列表查询路径，这里钉住字符安全语义。
    #[test]
    fn preview_is_safe_for_multibyte_content() {
        assert_eq!(
            make_key_preview("sk-中文密钥测试内容示例"),
            "sk-中文密钥测...内容示例"
        );
    }

    #[test]
    fn preview_elides_long_ascii_keys() {
        assert_eq!(make_key_preview("sk-abcdefghijklmnop"), "sk-abcde...mnop");
    }

    #[test]
    fn preview_threshold_follows_char_count() {
        // 12 个字符：进入省略分支
        assert_eq!(make_key_preview("sk-1234567890"), "sk-12345...7890");
        // 11 个字符：原样返回
        assert_eq!(make_key_preview("sk-12345678"), "sk-12345678");
    }

    #[test]
    fn preview_of_short_content_is_verbatim_after_trim() {
        assert_eq!(make_key_preview("  short  "), "short");
    }
}

#[cfg(test)]
mod move_to_top_tests {
    use crate::db::{move_rows_to_top, write_id_order, Connection};

    #[test]
    fn move_rows_to_top_orders_selected_ids_above_all_existing() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute(
            "CREATE TABLE t (id TEXT PRIMARY KEY, sort_order REAL)",
            [],
        )
        .unwrap();
        // 'b' 带时间戳级 sort_order（最新内容），'old' 是更早的记录。
        conn.execute(
            "INSERT INTO t (id, sort_order) VALUES ('b', 1700000000000.0), ('old', 1699999999999.0), ('x', 10.0)",
            [],
        )
        .unwrap();

        // 多选置顶：传入顺序即目标顺序（第一个最靠前）。
        move_rows_to_top(&conn, "t", &["x".to_string(), "old".to_string()]).unwrap();

        let mut stmt = conn
            .prepare("SELECT id FROM t ORDER BY sort_order DESC")
            .unwrap();
        let ids: Vec<String> = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(ids, vec!["x", "old", "b"]);
    }

    #[test]
    fn move_rows_to_top_with_empty_ids_is_noop() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute(
            "CREATE TABLE t (id TEXT PRIMARY KEY, sort_order REAL)",
            [],
        )
        .unwrap();
        move_rows_to_top(&conn, "t", &[]).unwrap();
    }

    // 重排序命令使用的归一化取值路径（(n-i)*10）：传入顺序即降序位置，
    // 未提及的行保持原 sort_order 不变（前端总是传全量可见列表）。
    #[test]
    fn write_id_order_normalized_values_match_given_order() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute(
            "CREATE TABLE t (id TEXT PRIMARY KEY, sort_order REAL)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO t (id, sort_order) VALUES ('a', 999.0), ('b', 998.0), ('c', 997.0)",
            [],
        )
        .unwrap();

        // 全量重排：传入顺序即最终顺序。
        write_id_order(&conn, "t", &["c".to_string(), "a".to_string(), "b".to_string()], |i, n| {
            ((n - i) * 10) as f64
        })
        .unwrap();
        let mut stmt = conn
            .prepare("SELECT id FROM t ORDER BY sort_order DESC")
            .unwrap();
        let ids: Vec<String> = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(ids, vec!["c", "a", "b"]);

        // 子集重排：未提及的行保持原值，可能排在被重排行之前或之后。
        write_id_order(&conn, "t", &["b".to_string(), "c".to_string()], |i, n| {
            ((n - i) * 10) as f64
        })
        .unwrap();
        let ids: Vec<String> = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        // b=20、c=10、a 保持 30（上一轮全量重排的值）。
        assert_eq!(ids, vec!["a", "b", "c"]);
    }
}

#[cfg(test)]
mod quick_input_file_tests {
    use crate::db::{
        is_legacy_quick_input_file_path, is_quick_input_text_preview_path,
        legacy_quick_input_target_path, paths_overlap, quick_input_relative_path,
    };
    use std::path::Path;

    #[test]
    fn quick_input_relative_path_preserves_original_filename() {
        assert_eq!(
            quick_input_relative_path("preset-1", "example.md"),
            "quick-input-files/preset-1/example.md"
        );
    }

    #[test]
    fn quick_input_text_preview_accepts_common_text_extensions() {
        assert!(is_quick_input_text_preview_path(
            "quick-input-files/preset-1/example.JSON"
        ));
        assert!(is_quick_input_text_preview_path(
            "quick-input-files/preset-1/example.txt"
        ));
        assert!(is_quick_input_text_preview_path(
            "quick-input-files/preset-1/example.toml"
        ));
        // 与资源区一致的常见文本格式均可预览。
        assert!(is_quick_input_text_preview_path(
            "quick-input-files/preset-1/example.md"
        ));
        assert!(is_quick_input_text_preview_path(
            "quick-input-files/preset-1/example.yaml"
        ));
        assert!(!is_quick_input_text_preview_path(
            "quick-input-files/preset-1/example.exe"
        ));
        assert!(!is_quick_input_text_preview_path("/tmp/example.json"));
    }

    #[test]
    fn legacy_quick_input_file_path_is_single_file_under_root() {
        assert!(is_legacy_quick_input_file_path(
            "quick-input-files/3fcb74c0-4738-4230-a5bc-51067b34ec0b.md"
        ));
        assert!(!is_legacy_quick_input_file_path(
            "quick-input-files/preset-1/example.md"
        ));
    }

    #[test]
    fn legacy_quick_input_target_path_uses_original_filename() {
        assert_eq!(
            legacy_quick_input_target_path(
                "quick-input-files/3fcb74c0-4738-4230-a5bc-51067b34ec0b.md",
                "/home/ao/docs/original.md"
            ),
            Some("quick-input-files/3fcb74c0-4738-4230-a5bc-51067b34ec0b/original.md".to_string())
        );
    }

    #[test]
    fn storage_directories_cannot_overlap() {
        let storage = Path::new("/home/user/.local/share/copy-creator");
        assert!(paths_overlap(
            storage,
            Path::new("/home/user/.local/share/copy-creator/resources")
        ));
        assert!(paths_overlap(storage, Path::new("/home/user/.local/share")));
        assert!(!paths_overlap(
            storage,
            Path::new("/home/user/Documents/resources")
        ));
    }
}

#[cfg(test)]
mod resource_file_tests {
    use crate::db::{
        is_temporary_resource_file_name, managed_resource_attachment_path,
        managed_resource_file_path, normalize_resource_folder_path,
        normalize_resource_group_name, resource_folder_for_path, resource_group_for_path,
        scan_resource_files, TEMPORARY_RESOURCE_EXTENSIONS,
    };
    use std::path::PathBuf;

    /// 函数契约要求绝对路径；Windows 上 "/tmp/..." 不是绝对路径，
    /// 因此按平台构造合成根目录，路径一律用 join 保持原生分隔符。
    fn synthetic_library_root() -> PathBuf {
        if cfg!(windows) {
            PathBuf::from("C:\\copy-creator-resource-library")
        } else {
            PathBuf::from("/tmp/copy-creator-resource-library")
        }
    }

    #[test]
    fn managed_resource_file_requires_generated_name_and_extension() {
        let root = &synthetic_library_root();
        let path = root.join("copy-creator-record-1-transaction-title.md");
        let roots = vec![root.clone()];
        assert_eq!(
            managed_resource_file_path(&roots, "record-1", path.to_str().unwrap()),
            Some((path.clone(), roots[0].clone()))
        );
        assert!(managed_resource_file_path(
            &roots,
            "record-1",
            root.join("copy-creator-record-1-transaction-title.md.bak")
                .to_str()
                .unwrap(),
        )
        .is_none());
        assert!(managed_resource_file_path(
            &roots,
            "record-2",
            path.to_str().unwrap(),
        )
        .is_none());
        assert!(managed_resource_file_path(
            &roots,
            "record-1",
            "resource-library/copy-creator-record-1-transaction-title.md",
        )
        .is_none());
    }

    #[test]
    fn managed_resource_attachment_must_be_direct_child_of_record_directory() {
        let root = &synthetic_library_root();
        let path = root.join(".copy-creator/attachments/record-1-transaction/image-1.png");
        let directory = root.join(".copy-creator/attachments/record-1-transaction");
        assert_eq!(
            managed_resource_attachment_path(root, "record-1", path.to_str().unwrap(),),
            Some((path, directory))
        );
        assert!(managed_resource_attachment_path(
            root,
            "record-1",
            root.join(".copy-creator/attachments/record-2-transaction/image-1.png")
                .to_str()
                .unwrap(),
        )
        .is_none());
        assert!(
            managed_resource_attachment_path(
                root,
                "record-1",
                root.join(".copy-creator/attachments/record-1-transaction/nested/image-1.png")
                    .to_str()
                    .unwrap(),
            )
            .is_none()
        );
        let other = synthetic_library_root();
        let other = if other == *root {
            PathBuf::from("C:\\other-library")
        } else {
            other
        };
        assert!(managed_resource_attachment_path(
            root,
            "record-1",
            other.join(".copy-creator/attachments/record-1-transaction/image-1.png")
                .to_str()
                .unwrap(),
        )
        .is_none());
        assert!(managed_resource_attachment_path(
            root,
            "record-1",
            root.join(".copy-creator/attachments/record-1-transaction/image-0.png")
                .to_str()
                .unwrap(),
        )
        .is_none());
    }

    #[test]
    fn resource_group_name_rejects_path_traversal_and_nested_paths() {
        assert_eq!(
            normalize_resource_group_name(Some("  References  ")).unwrap(),
            "References"
        );
        assert!(normalize_resource_group_name(Some(".hidden")).is_err());
        assert!(normalize_resource_group_name(Some("../outside")).is_err());
        assert!(normalize_resource_group_name(Some("nested/group")).is_err());
        assert!(normalize_resource_group_name(Some("nested\\group")).is_err());
        assert!(normalize_resource_group_name(Some(&"x".repeat(81))).is_err());
    }

    #[test]
    fn resource_folder_path_normalizes_nested_segments() {
        assert_eq!(
            normalize_resource_folder_path(Some(" 人物三视图\\放大后/细节 ")).unwrap(),
            "人物三视图/放大后/细节"
        );
        assert_eq!(normalize_resource_folder_path(Some("")).unwrap(), "");
        assert!(normalize_resource_folder_path(Some("人物三视图//细节")).is_err());
        assert!(normalize_resource_folder_path(Some("人物三视图/../细节")).is_err());
    }

    #[test]
    fn resource_folder_for_path_returns_the_complete_relative_directory() {
        let root = &synthetic_library_root();
        assert_eq!(
            resource_folder_for_path(
                root,
                root.join("copy-creator-record-1-title.txt").to_str().unwrap(),
            ),
            Some(String::new())
        );
        assert_eq!(
            resource_folder_for_path(
                root,
                root.join("References/archive/deep/file.txt").to_str().unwrap(),
            ),
            Some("References/archive/deep".to_string())
        );
        let other = synthetic_library_root();
        let other = if other == *root {
            PathBuf::from("C:\\other-library")
        } else {
            other
        };
        assert_eq!(
            resource_folder_for_path(
                root,
                other.join("other-library/file.txt").to_str().unwrap(),
            ),
            None
        );
    }

    #[test]
    fn resource_group_for_path_distinguishes_root_and_first_level_folder() {
        let root = &synthetic_library_root();
        assert_eq!(
            resource_group_for_path(
                root,
                root.join("copy-creator-record-1-title.txt").to_str().unwrap(),
            ),
            Some(String::new())
        );
        assert_eq!(
            resource_group_for_path(
                root,
                root.join("References/copy-creator-record-2-title.md").to_str().unwrap(),
            ),
            Some("References".to_string())
        );
        assert_eq!(
            resource_group_for_path(
                root,
                root.join("References/archive/copy-creator-record-3-title.md")
                    .to_str()
                    .unwrap(),
            ),
            Some("References".to_string())
        );
        let other = synthetic_library_root();
        let other = if other == *root {
            PathBuf::from("C:\\other-library")
        } else {
            other
        };
        assert_eq!(
            resource_group_for_path(
                root,
                other.join("other-library/copy-creator-record-4-title.txt").to_str().unwrap(),
            ),
            None
        );        assert_eq!(
            resource_group_for_path(
                root,
                root.join("References/../outside/file.txt").to_str().unwrap(),
            ),
            None
        );
    }

    #[test]
    fn scans_nested_resource_files_and_classifies_media_types() {
        let root = std::env::temp_dir().join(format!(
            "copy-creator-resource-scan-test-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(root.join("References/archive")).unwrap();
        std::fs::create_dir_all(root.join(".copy-creator")).unwrap();
        std::fs::write(root.join("root.txt"), "root").unwrap();
        std::fs::write(root.join("References/image.PNG"), b"image").unwrap();
        std::fs::write(root.join("References/archive/note.md"), "note").unwrap();
        std::fs::write(root.join("References/movie.mp4"), b"video").unwrap();
        std::fs::write(root.join("References/sound.ogg"), b"audio").unwrap();
        std::fs::write(root.join("References/archive/archive.bin"), [0, 1, 2]).unwrap();
        std::fs::write(root.join("References/.resource.tmp"), b"ignored").unwrap();
        // 半成品下载与锁文件：扫描不得收录（覆盖完成后以真实文件名再入库）。
        // 纯 .tmp 与 .crdownload/.part 同清单处理（b66122d 起的既定行为）。
        std::fs::write(root.join("References/notes.tmp"), b"temporary text").unwrap();
        std::fs::write(root.join("References/未确认 409376.crdownload"), [0, 1]).unwrap();
        std::fs::write(root.join("References/notes.part"), b"partial").unwrap();
        std::fs::write(root.join("References/~$report.docx"), b"lock").unwrap();
        std::fs::write(root.join("References/desktop.ini"), b"system").unwrap();
        std::fs::write(root.join(".copy-creator/hidden.txt"), b"hidden").unwrap();

        let entries = scan_resource_files(&root);
        // 断言以 `/` 分隔符书写；Windows 实际路径为 `\`，语义等价，归一后比较。
        let relative_paths = entries
            .iter()
            .map(|entry| {
                entry
                    .path
                    .strip_prefix(&root)
                    .unwrap()
                    .to_string_lossy()
                    .to_string()
                    .replace('\\', "/")
            })
            .collect::<Vec<_>>();
        assert_eq!(
            relative_paths,
            vec![
                "References/archive/archive.bin",
                "References/archive/note.md",
                "References/image.PNG",
                "References/movie.mp4",
                "References/sound.ogg",
                "root.txt",
            ]
        );
        assert_eq!(
            entries
                .iter()
                .map(|entry| (
                    entry
                        .path
                        .strip_prefix(&root)
                        .unwrap()
                        .to_string_lossy()
                        .to_string()
                        .replace('\\', "/"),
                    entry.group.clone(),
                ))
                .collect::<Vec<_>>(),
            vec![
                (
                    "References/archive/archive.bin".to_string(),
                    "References".to_string(),
                ),
                (
                    "References/archive/note.md".to_string(),
                    "References".to_string(),
                ),
                (
                    "References/image.PNG".to_string(),
                    "References".to_string(),
                ),
                (
                    "References/movie.mp4".to_string(),
                    "References".to_string(),
                ),
                (
                    "References/sound.ogg".to_string(),
                    "References".to_string(),
                ),
                ("root.txt".to_string(), "".to_string()),
            ]
        );
        assert!(crate::media_kind::is_text_extension(&root.join("README.MD")));
        // 扫描产物不再携带媒体分类（入库统一 type='file'，渲染期按路径
        // 判定）；分类器行为属于 media_kind 模块，这里保留代表性扩展名
        // 与未知扩展名的兜底断言。
        assert_eq!(
            crate::media_kind::media_kind_for_path(&root.join("References/image.PNG")).as_str(),
            "image"
        );
        assert_eq!(
            crate::media_kind::media_kind_for_path(&root.join("References/movie.mp4")).as_str(),
            "video"
        );
        assert_eq!(
            crate::media_kind::media_kind_for_path(&root.join("References/sound.ogg")).as_str(),
            "audio"
        );
        assert_eq!(
            crate::media_kind::media_kind_for_path(&root.join("References/notes.tmp")).as_str(),
            "text"
        );
        assert_eq!(
            crate::media_kind::media_kind_for_path(&root.join("unknown.bin")).as_str(),
            "file"
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn temporary_resource_rules_cover_scan_and_prune_consistently() {
        for name in [
            "未确认 409376.crdownload",
            "d99cb95b-c1be-4400-95c5-f334a965cf30.tmp",
            "archive.TEMP",
            "notes.part",
            "setup.download",
            "file.partial",
            "movie.opdownload",
            ".notes.swp",
            "swap.swo",
            "~$report.docx",
            ".~lock.notes.txt#",
            "desktop.ini",
            "THUMBS.DB",
        ] {
            assert!(
                is_temporary_resource_file_name(name),
                "{name} 应判为临时/系统文件"
            );
        }
        for name in [
            "report.docx",
            "photo.png",
            "tmp",
            "tips",
            "desktop.ini.bak",
            "parliament.txt",
        ] {
            assert!(
                !is_temporary_resource_file_name(name),
                "{name} 不应判为临时/系统文件"
            );
        }
        // 清退 SQL 的条件必须与判定函数覆盖同一份扩展名清单。
        let conditions: Vec<String> = TEMPORARY_RESOURCE_EXTENSIONS
            .iter()
            .map(|extension| format!("LOWER(resource_path) LIKE '%.{extension}'"))
            .collect();
        for extension in TEMPORARY_RESOURCE_EXTENSIONS {
            assert!(
                conditions
                    .iter()
                    .any(|condition| condition.contains(&format!(".{extension}'"))),
                "清退 SQL 缺少扩展名 {extension}"
            );
        }
    }
}

#[cfg(test)]
mod record_classification_tests {
    use crate::db::{category_sql, is_resource_record};

    #[test]
    fn treats_only_resource_storage_mode_as_resource() {
        assert!(is_resource_record("resource"));
        assert!(!is_resource_record("database"));
    }

    #[test]
    fn resource_category_sql_filters_by_storage_mode() {
        let (filter, search_filter) = category_sql(&Some("resources".to_string()));

        assert!(filter.contains("storage_mode = 'resource'"));
        assert!(!filter.contains("group_name"));
        assert!(search_filter.contains("storage_mode = 'resource'"));
        assert!(!search_filter.contains("group_name"));
    }

    #[test]
    fn temp_category_falls_back_to_plain_clipboard_filter() {
        let (filter, search_filter) = category_sql(&Some("temp".to_string()));

        assert!(filter.contains("NOT (storage_mode = 'resource')"));
        assert!(!filter.contains("group_name"));
        assert!(search_filter.contains("NOT (storage_mode = 'resource')"));
        assert!(!search_filter.contains("group_name"));
    }
}

#[cfg(test)]
mod resource_command_tests {
    use crate::db::{
        create_resource_group_inner, delete_external_resource_file, delete_resource_group_inner,
        forget_resource_records, get_clipboard_records_inner, get_resource_groups_inner,
        move_resource_group_inner, move_resource_records_inner, read_resource_text_preview_file,
        read_text_file_content_inner, rename_resource_file_inner,
        reorder_resource_groups_inner, resolve_resource_file_path, resource_file_id,
        resource_folder_tree, resource_group_count_map, set_resource_note_inner,
        settle_external_resource_changes, simplify_windows_path,
        restore_staged_external_resource_files, stage_external_resource_files,
        validate_resource_rename_stem, update_resource_group_inner,
        DbState, RESOURCE_INDEX_MIGRATION_SQL, RESOURCE_TEXT_PASTE_LIMIT_BYTES,
    };
    use rusqlite::Connection;
    use std::path::{Path, PathBuf};
    use std::sync::Mutex;
    use std::time::Duration;
    use tauri::Manager;

    /// 断言前把路径分隔符归一为 `/`：期望值以 POSIX 风格书写，
    /// 实际值在 Windows 上使用 `\`，语义等价。
    fn slash_normalized(path: &str) -> String {
        path.replace('\\', "/")
    }

    fn test_app() -> (tauri::App<tauri::test::MockRuntime>, PathBuf) {
        let app = tauri::test::mock_app();
        let root = std::env::temp_dir().join(format!(
            "copy-creator-resource-command-test-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&root).unwrap();
        // TEMP 环境变量在部分机器上是短路径名（如 GAOSHI~1）；与运行时
        // validate_resource_library_path 的行为一致地取规范长路径，
        // 保证夹具、扫描与 canonicalize 产物为同一路径形态。
        let root = simplify_windows_path(&root.canonicalize().unwrap());

        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             CREATE TABLE clipboard_records (
                 id TEXT PRIMARY KEY,
                 type TEXT NOT NULL,
                 content TEXT NOT NULL,
                 source_app TEXT DEFAULT '',
                 created_at TEXT NOT NULL,
                 user_api_key INTEGER DEFAULT 0,
                 sort_order REAL,
                 group_name TEXT DEFAULT '',
                 attachments TEXT DEFAULT '[]',
                 storage_mode TEXT DEFAULT 'database',
                 resource_path TEXT DEFAULT '',
                 resource_note TEXT DEFAULT '',
                 resource_external INTEGER DEFAULT 0,
                 last_used_at TEXT DEFAULT '',
                 use_count INTEGER DEFAULT 0,
                 touched_ms INTEGER DEFAULT 0,
                 pinned INTEGER NOT NULL DEFAULT 0
             );
             CREATE TABLE IF NOT EXISTS trash_items (
                 id TEXT PRIMARY KEY,
                 record_id TEXT DEFAULT '',
                 record_json TEXT NOT NULL,
                 file_name TEXT DEFAULT '',
                 original_group TEXT DEFAULT '',
                 original_path TEXT DEFAULT '',
                 trash_dir TEXT NOT NULL,
                 trashed_at TEXT NOT NULL,
                 trashed_ms INTEGER NOT NULL DEFAULT 0
             );
             CREATE TABLE api_key_labels (
                 record_id TEXT PRIMARY KEY,
                 label TEXT DEFAULT ''
             );
             INSERT INTO settings (key, value) VALUES ('resource_library_path', '');",
        )
        .unwrap();
        app.manage(DbState {
            conn: Mutex::new(conn),
        });
        {
            let state = app.state::<DbState>();
            let conn = state.conn.lock().unwrap();
            conn.execute(
                "UPDATE settings SET value = ?1 WHERE key = 'resource_library_path'",
                [&root.to_string_lossy().to_string()],
            )
            .unwrap();
        }

        (app, root)
    }

    fn insert_resource(
        app: &tauri::App<tauri::test::MockRuntime>,
        id: &str,
        sort_order: f64,
        group_name: &str,
        resource_path: &str,
    ) {
        let state = app.state::<DbState>();
        let conn = state.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO clipboard_records
             (id, type, content, created_at, sort_order, group_name, storage_mode, resource_path)
             VALUES (?1, 'text', ?2, '2026-08-01T00:00:00Z', ?3, ?4, 'resource', ?5)",
            (id, id, sort_order, group_name, resource_path),
        )
        .unwrap();
    }

    fn insert_typed_resource(
        app: &tauri::App<tauri::test::MockRuntime>,
        id: &str,
        record_type: &str,
        content: &str,
        resource_path: &str,
    ) {
        let state = app.state::<DbState>();
        let conn = state.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO clipboard_records
             (id, type, content, created_at, sort_order, group_name, storage_mode, resource_path)
             VALUES (?1, ?2, ?3, '2026-08-01T00:00:00Z', 10.0, '', 'resource', ?4)",
            (id, record_type, content, resource_path),
        )
        .unwrap();
    }

    fn cleanup(root: &PathBuf) {
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn resource_record_query_returns_without_reentrant_database_lock() {
        let (app, root) = test_app();
        let group = root.join("References");
        std::fs::create_dir_all(&group).unwrap();
        let path = group.join("copy-creator-resource-1.txt");
        std::fs::write(&path, "resource").unwrap();
        insert_resource(
            &app,
            "resource-1",
            10.0,
            "References",
            path.to_str().unwrap(),
        );

        let handle = app.handle().clone();
        let (sender, receiver) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let result = get_clipboard_records_inner(
                &handle,
                None,
                Some(120),
                Some(0),
                Some("resources".to_string()),
                Some("References".to_string()),
        None,
    );
            sender.send(result).unwrap();
        });
        let records = receiver
            .recv_timeout(Duration::from_secs(2))
            .expect("资源列表查询不应因重复获取数据库锁而阻塞")
            .unwrap();

        assert_eq!(records.len(), 1);
        assert_eq!(records[0]["resource_group"], "References");
        cleanup(&root);
    }

    #[test]
    fn resource_group_filter_supports_pagination_and_ungrouped_records() {
        let (app, root) = test_app();
        let group = root.join("References");
        std::fs::create_dir_all(&group).unwrap();
        let root_path = root.join("copy-creator-resource-root.txt");
        let first_group_path = group.join("copy-creator-resource-first.txt");
        let second_group_path = group.join("copy-creator-resource-second.txt");
        for path in [&root_path, &first_group_path, &second_group_path] {
            std::fs::write(path, "resource").unwrap();
        }
        insert_resource(&app, "root", 30.0, "", root_path.to_str().unwrap());
        insert_resource(
            &app,
            "first",
            20.0,
            "References",
            first_group_path.to_str().unwrap(),
        );
        insert_resource(
            &app,
            "second",
            10.0,
            "References",
            second_group_path.to_str().unwrap(),
        );

        let handle = app.handle().clone();
        let page = get_clipboard_records_inner(
            &handle,
            None,
            Some(1),
            Some(1),
            Some("resources".to_string()),
            Some("References".to_string()),
        None,
    )
        .unwrap();
        assert_eq!(page.len(), 1);
        assert_eq!(page[0]["id"], "second");

        let ungrouped = get_clipboard_records_inner(
            &handle,
            None,
            Some(120),
            Some(0),
            Some("resources".to_string()),
            Some(String::new()),
        None,
    )
        .unwrap();
        assert_eq!(
            ungrouped
                .iter()
                .map(|record| &record["id"])
                .collect::<Vec<_>>(),
            vec![&serde_json::json!("root")]
        );
        cleanup(&root);
    }

    #[test]
    fn resource_folder_filter_includes_only_the_selected_folder_and_its_descendants() {
        let (app, root) = test_app();
        let selected = root.join("References/archive");
        std::fs::create_dir_all(selected.join("deep")).unwrap();
        let selected_file = selected.join("selected.txt");
        let descendant_file = selected.join("deep/descendant.txt");
        let sibling_file = root.join("References/other.txt");
        for path in [&selected_file, &descendant_file, &sibling_file] {
            std::fs::write(path, "resource").unwrap();
        }
        insert_resource(
            &app,
            "selected",
            30.0,
            "References",
            selected_file.to_str().unwrap(),
        );
        insert_resource(
            &app,
            "descendant",
            20.0,
            "References",
            descendant_file.to_str().unwrap(),
        );
        insert_resource(
            &app,
            "sibling",
            10.0,
            "References",
            sibling_file.to_str().unwrap(),
        );

        let records = get_clipboard_records_inner(
            &app.handle().clone(),
            None,
            Some(120),
            Some(0),
            Some("resources".to_string()),
            Some("References/archive".to_string()),
            None,
        )
        .unwrap();

        assert_eq!(
            records
                .iter()
                .map(|record| record["id"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec!["selected", "descendant"]
        );
        assert!(records
            .iter()
            .all(|record| record["resource_group"] == "References"));
        cleanup(&root);
    }

    #[test]
    fn resource_note_is_searchable_for_database_records() {
        let (app, root) = test_app();
        let file = root.join("copy-creator-noted.txt");
        std::fs::write(&file, "resource").unwrap();
        insert_resource(&app, "noted", 30.0, "", file.to_str().unwrap());

        let saved = set_resource_note_inner(app.handle(), "noted".to_string(), " 林黛玉 三视图 ".to_string())
            .unwrap();
        assert_eq!(saved, "林黛玉 三视图");

        let records = get_clipboard_records_inner(
            &app.handle().clone(),
            Some("林黛玉".to_string()),
            Some(120),
            Some(0),
            Some("resources".to_string()),
            None,
            None,
        )
        .unwrap();
        assert_eq!(
            records
                .iter()
                .map(|record| record["id"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec!["noted"]
        );
        assert_eq!(records[0]["resource_note"], "林黛玉 三视图");

        let none = get_clipboard_records_inner(
            &app.handle().clone(),
            Some("贾宝玉".to_string()),
            Some(120),
            Some(0),
            Some("resources".to_string()),
            None,
        None,
    )
        .unwrap();
        assert!(none.is_empty());
        cleanup(&root);
    }

    #[test]
    fn resource_note_creates_a_record_for_a_discovered_file() {
        let (app, root) = test_app();
        let file = root.join("discovered.mp4");
        std::fs::write(&file, "video").unwrap();
        let id = resource_file_id(&file);

        let saved = set_resource_note_inner(app.handle(), id.clone(), "雨夜车站".to_string()).unwrap();
        assert_eq!(saved, "雨夜车站");

        let records = get_clipboard_records_inner(
            &app.handle().clone(),
            Some("雨夜车站".to_string()),
            Some(120),
            Some(0),
            Some("resources".to_string()),
            None,
        None,
    )
        .unwrap();
        assert_eq!(records.len(), 1, "补建记录后不应与扫描结果重复");
        assert_eq!(records[0]["id"].as_str().unwrap(), id);
        assert_eq!(records[0]["storage_mode"], "resource");
        assert_eq!(records[0]["resource_note"], "雨夜车站");

        let cleared = set_resource_note_inner(app.handle(), id, "  ".to_string()).unwrap();
        assert_eq!(cleared, "");
        let records = get_clipboard_records_inner(
            &app.handle().clone(),
            Some("雨夜车站".to_string()),
            Some(120),
            Some(0),
            Some("resources".to_string()),
            None,
        None,
    )
        .unwrap();
        assert!(records.is_empty());
        cleanup(&root);
    }

    #[test]
    fn resource_groups_return_a_nested_folder_tree() {
        let (_app, root) = test_app();
        std::fs::create_dir_all(root.join("人物三视图/放大后/细节")).unwrap();

        let group = resource_folder_tree(
            &root,
            &root.join("人物三视图"),
            &std::collections::HashMap::new(),
            &std::collections::HashMap::new(),
        )
        .unwrap();
        assert_eq!(group["name"], "人物三视图");
        assert_eq!(group["children"][0]["path"], "人物三视图/放大后");
        assert_eq!(
            group["children"][0]["children"][0]["path"],
            "人物三视图/放大后/细节"
        );
        cleanup(&root);
    }

    #[test]
    fn resource_groups_follow_the_persisted_manual_order() {
        let (app, root) = test_app();
        std::fs::create_dir_all(root.join("甲")).unwrap();
        std::fs::create_dir_all(root.join("乙/子")).unwrap();
        std::fs::create_dir_all(root.join("丙")).unwrap();

        reorder_resource_groups_inner(
            app.handle(),
            vec!["甲".to_string(), "丙".to_string(), "乙".to_string()],
        )
        .unwrap();
        let groups = get_resource_groups_inner(app.handle()).unwrap();
        let names: Vec<&str> = groups
            .iter()
            .skip(1)
            .map(|group| group["name"].as_str().unwrap())
            .collect();
        assert_eq!(names, vec!["甲", "丙", "乙"]);
        assert_eq!(groups[3]["children"][0]["path"], "乙/子");

        // 改名与移动后顺序跟随新路径；未登记的新分组排在已登记分组之后。
        update_resource_group_inner(app.handle(), "丙".to_string(), "丁".to_string()).unwrap();
        move_resource_group_inner(app.handle(), "乙".to_string(), "丁".to_string()).unwrap();
        std::fs::create_dir_all(root.join("戊")).unwrap();
        let groups = get_resource_groups_inner(app.handle()).unwrap();
        let names: Vec<&str> = groups
            .iter()
            .skip(1)
            .map(|group| group["name"].as_str().unwrap())
            .collect();
        assert_eq!(names, vec!["甲", "丁", "戊"]);
        assert_eq!(groups[2]["children"][0]["path"], "丁/乙");
        assert_eq!(groups[2]["children"][0]["children"][0]["path"], "丁/乙/子");

        // 删除分组后其路径从顺序表中移除。
        delete_resource_group_inner(app.handle(), "丁".to_string()).unwrap();
        let groups = get_resource_groups_inner(app.handle()).unwrap();
        let names: Vec<&str> = groups
            .iter()
            .skip(1)
            .map(|group| group["name"].as_str().unwrap())
            .collect();
        assert_eq!(names, vec!["甲", "戊"]);
        cleanup(&root);
    }

    #[test]
    fn nested_group_creation_creates_missing_parents_and_counts_descendants() {
        let (app, root) = test_app();
        let group = root.join("工作资料/角色");
        std::fs::create_dir_all(&group).unwrap();
        let file = group.join("林黛玉.png");
        std::fs::write(&file, [1_u8]).unwrap();
        insert_typed_resource(
            &app,
            "resource-1",
            "file",
            file.to_str().unwrap(),
            file.to_str().unwrap(),
        );

        let groups = get_resource_groups_inner(app.handle()).unwrap();
        let work = groups.iter().find(|group| group["name"] == "工作资料").unwrap();
        assert_eq!(work["path"], "工作资料");
        assert_eq!(work["count"], 1);
        assert_eq!(work["children"][0]["name"], "角色");
        assert_eq!(work["children"][0]["count"], 1);

        let created = create_resource_group_inner(app.handle(), "工作资料/场景").unwrap();
        assert_eq!(created["name"], "工作资料/场景");
        assert!(root.join("工作资料/场景").is_dir());
        assert!(create_resource_group_inner(app.handle(), "工作资料/场景").is_err());
        cleanup(&root);
    }

    #[test]
    fn renaming_nested_group_updates_paths_and_keeps_top_group() {
        let (app, root) = test_app();
        let file = root.join("工作资料/角色/林黛玉.png");
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, [1_u8]).unwrap();
        insert_typed_resource(
            &app,
            "resource-1",
            "file",
            file.to_str().unwrap(),
            file.to_str().unwrap(),
        );

        update_resource_group_inner(
            app.handle(),
            "工作资料/角色".to_string(),
            "工作资料/人物".to_string(),
        )
        .unwrap();

        let renamed = root.join("工作资料/人物/林黛玉.png");
        assert!(renamed.is_file());
        let state = app.state::<DbState>();
        let conn = state.conn.lock().unwrap();
        let (group_name, resource_path): (String, String) = conn
            .query_row(
                "SELECT group_name, resource_path FROM clipboard_records WHERE id = 'resource-1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(group_name, "工作资料");
        assert_eq!(slash_normalized(&resource_path), slash_normalized(&renamed.to_string_lossy()));
        cleanup(&root);
    }

    #[test]
    fn moving_group_updates_records_and_markdown_depth() {
        let (app, root) = test_app();
        let attachments = root.join(".copy-creator/attachments/unit-1");
        std::fs::create_dir_all(&attachments).unwrap();
        std::fs::write(attachments.join("image-1.png"), [1_u8]).unwrap();
        let md_file = root.join("工作资料/角色/note.md");
        std::fs::create_dir_all(md_file.parent().unwrap()).unwrap();
        std::fs::write(&md_file, "图：![img](../../.copy-creator/attachments/unit-1/image-1.png)\n")
            .unwrap();
        insert_typed_resource(
            &app,
            "resource-1",
            "file",
            md_file.to_str().unwrap(),
            md_file.to_str().unwrap(),
        );
        std::fs::create_dir_all(root.join("项目资料")).unwrap();

        move_resource_group_inner(
            app.handle(),
            "工作资料/角色".to_string(),
            "项目资料".to_string(),
        )
        .unwrap();

        let moved_md = root.join("项目资料/角色/note.md");
        assert!(moved_md.is_file());
        assert!(!md_file.exists());
        // 移动前后都是二级目录，附件链接层级不变。
        let content = std::fs::read_to_string(&moved_md).unwrap();
        assert_eq!(
            content,
            "图：![img](../../.copy-creator/attachments/unit-1/image-1.png)\n"
        );
        let state = app.state::<DbState>();
        let conn = state.conn.lock().unwrap();
        let (group_name, resource_path): (String, String) = conn
            .query_row(
                "SELECT group_name, resource_path FROM clipboard_records WHERE id = 'resource-1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(group_name, "项目资料");
        assert_eq!(
            slash_normalized(&resource_path),
            slash_normalized(&moved_md.to_string_lossy())
        );

        let error = move_resource_group_inner(
            app.handle(),
            "项目资料/角色".to_string(),
            "项目资料/角色/更深层".to_string(),
        )
        .unwrap_err();
        assert!(error.contains("不能把分组移动到"));
        cleanup(&root);
    }

    #[test]
    fn moving_group_to_top_level_restores_root_depth() {
        let (app, root) = test_app();
        let md_file = root.join("工作资料/角色/note.md");
        std::fs::create_dir_all(md_file.parent().unwrap()).unwrap();
        std::fs::write(&md_file, "图：![img](../../.copy-creator/attachments/unit-1/image-1.png)\n")
            .unwrap();
        insert_typed_resource(
            &app,
            "resource-1",
            "file",
            md_file.to_str().unwrap(),
            md_file.to_str().unwrap(),
        );

        move_resource_group_inner(app.handle(), "工作资料/角色".to_string(), String::new()).unwrap();

        let moved_md = root.join("角色/note.md");
        assert!(moved_md.is_file());
        let content = std::fs::read_to_string(&moved_md).unwrap();
        assert_eq!(
            content,
            "图：![img](../.copy-creator/attachments/unit-1/image-1.png)\n"
        );
        cleanup(&root);
    }

    #[test]
    fn resource_query_includes_external_files_recursively_and_deduplicates_managed_files() {
        let (app, root) = test_app();
        let nested = root.join("References").join("archive");
        std::fs::create_dir_all(&nested).unwrap();
        let managed = root.join("References").join("managed.txt");
        let root_text = root.join("root.txt");
        let image = root.join("References").join("image.png");
        let video = nested.join("movie.mp4");
        let audio = nested.join("sound.ogg");
        let binary = nested.join("archive.bin");
        for (path, content) in [
            (&managed, b"managed".as_slice()),
            (&root_text, b"root".as_slice()),
            (&image, b"image".as_slice()),
            (&video, b"video".as_slice()),
            (&audio, b"audio".as_slice()),
            (&binary, &[0_u8, 1, 2][..]),
        ] {
            std::fs::write(path, content).unwrap();
        }
        insert_resource(
            &app,
            "managed",
            100.0,
            "References",
            managed.to_str().unwrap(),
        );

        // 索引维护已移出查询路径：磁盘文件经启动/切换对账入库（生产中由
        // lib.rs 启动线程与 set_resource_library_path 调用）。
        crate::db::sync_resource_library(app.handle());
        let records = get_clipboard_records_inner(
            &app.handle().clone(),
            None,
            Some(120),
            Some(0),
            Some("resources".to_string()),
            None,
        None,
    )
        .unwrap();
        assert_eq!(records.len(), 6);
        let mut kinds = records
            .iter()
            .map(|record| {
                (
                    slash_normalized(record["resource_relative_path"].as_str().unwrap()),
                    record["resource_kind"].as_str().unwrap().to_string(),
                )
            })
            .collect::<Vec<_>>();
        kinds.sort_by(|(a, _), (b, _)| a.cmp(b));
        assert_eq!(
            kinds,
            vec![
                ("References/archive/archive.bin", "file"),
                ("References/archive/movie.mp4", "video"),
                ("References/archive/sound.ogg", "audio"),
                ("References/image.png", "image"),
                ("References/managed.txt", "text"),
                ("root.txt", "text"),
            ]
            .into_iter()
            .map(|(path, kind)| (path.to_string(), kind.to_string()))
            .collect::<Vec<_>>()
        );
        let root_record = records
            .iter()
            .find(|record| record["id"] == crate::db::resource_file_id(&root_text))
            .unwrap();
        assert_eq!(root_record["resource_group"], "");
        assert_eq!(root_record["resource_folder"], "");
        assert_eq!(root_record["resource_relative_path"], "root.txt");
        assert_eq!(root_record["resource_managed"], false);
        let nested_record = records
            .iter()
            .find(|record| record["id"] == crate::db::resource_file_id(&video))
            .unwrap();
        assert_eq!(nested_record["resource_group"], "References");
        assert_eq!(nested_record["resource_folder"], "References/archive");
        assert_eq!(
            slash_normalized(nested_record["resource_relative_path"].as_str().unwrap()),
            "References/archive/movie.mp4"
        );
        assert!(records
            .iter()
            .all(|record| slash_normalized(record["id"].as_str().unwrap())
                != slash_normalized(&resource_file_id(&managed))));

        let counts = resource_group_count_map(app.handle()).unwrap();
        assert_eq!(counts.get("").copied(), Some(1));
        assert_eq!(counts.get("References").copied(), Some(2));
        assert_eq!(counts.get("References/archive").copied(), Some(3));
        cleanup(&root);
    }

    #[test]
    fn resource_text_preview_is_limited_to_the_configured_library() {
        let (app, root) = test_app();
        let text = root.join("References/nested.txt");
        std::fs::create_dir_all(text.parent().unwrap()).unwrap();
        std::fs::write(&text, "预览内容").unwrap();
        assert_eq!(
            read_resource_text_preview_file(
                resolve_resource_file_path(app.handle(), text.to_string_lossy().as_ref()).unwrap()
            )
            .unwrap(),
            "预览内容"
        );

        let outside = root.parent().unwrap().join(format!(
            "copy-creator-resource-outside-{}.txt",
            uuid::Uuid::new_v4()
        ));
        std::fs::write(&outside, "outside").unwrap();
        assert!(
            resolve_resource_file_path(app.handle(), outside.to_string_lossy().as_ref()).is_err()
        );
        assert!(resolve_resource_file_path(
            app.handle(),
            root.join(".copy-creator/secret.txt")
                .to_string_lossy()
                .as_ref()
        )
        .is_err());
        let _ = std::fs::remove_file(outside);
        cleanup(&root);
    }

    #[test]
    fn text_file_content_read_is_limited_to_library_text_files() {
        let (app, root) = test_app();
        let text = root.join("分镜提词/镜头.txt");
        std::fs::create_dir_all(text.parent().unwrap()).unwrap();
        std::fs::write(&text, "第一行\n第二行\n").unwrap();
        assert_eq!(
            read_text_file_content_inner(app.handle(), text.to_string_lossy().as_ref()).unwrap(),
            "第一行\n第二行\n"
        );

        // 非 UTF-8 内容读取失败，交由前端回退为文件粘贴。
        let binary = root.join("binary.txt");
        std::fs::write(&binary, [0xff, 0xfe, 0xfd]).unwrap();
        assert!(read_text_file_content_inner(app.handle(), binary.to_string_lossy().as_ref())
            .is_err());

        // 超过粘贴大小上限的文本文件拒绝读取。
        let oversized = root.join("oversized.txt");
        let oversized_text = "好".repeat((RESOURCE_TEXT_PASTE_LIMIT_BYTES / 3 + 1) as usize);
        std::fs::write(&oversized, &oversized_text).unwrap();
        assert!(
            std::fs::metadata(&oversized).unwrap().len() > RESOURCE_TEXT_PASTE_LIMIT_BYTES
        );
        assert!(read_text_file_content_inner(app.handle(), oversized.to_string_lossy().as_ref())
            .is_err());

        // 资源库外的路径一律拒绝。
        let outside = root.parent().unwrap().join(format!(
            "copy-creator-resource-outside-{}.txt",
            uuid::Uuid::new_v4()
        ));
        std::fs::write(&outside, "outside").unwrap();
        assert!(
            read_text_file_content_inner(app.handle(), outside.to_string_lossy().as_ref()).is_err()
        );
        let _ = std::fs::remove_file(outside);
        cleanup(&root);
    }

    #[test]
    fn external_resource_file_ids_resolve_only_to_files_inside_the_library() {
        let (app, root) = test_app();
        let selected = root.join("selected.bin");
        let retained = root.join("retained.bin");
        std::fs::write(&selected, [1_u8, 2, 3]).unwrap();
        std::fs::write(&retained, [4_u8, 5, 6]).unwrap();
        let resolved =
            resolve_resource_file_path(app.handle(), selected.to_string_lossy().as_ref()).unwrap();
        // 解析结果保持常规形态（无 `\\?\` 扩展前缀），与扫描出的记录路径一致。
        assert_eq!(resolved, simplify_windows_path(&selected.canonicalize().unwrap()));
        delete_external_resource_file(app.handle(), &resolved).unwrap();
        assert!(!selected.exists());
        assert!(retained.exists());
        cleanup(&root);
    }

    #[test]
    fn simplify_windows_path_strips_verbatim_prefix_only_for_known_forms() {
        use crate::db::simplify_windows_path;
        // 本地盘符：剥离扩展前缀。
        assert_eq!(
            simplify_windows_path(Path::new(r"\\?\C:\lib\x.png")),
            Path::new(r"C:\lib\x.png")
        );
        // UNC：还原 \\server\share 形态。
        assert_eq!(
            simplify_windows_path(Path::new(r"\\?\UNC\srv\share\x.png")),
            Path::new(r"\\srv\share\x.png")
        );
        // 常规路径保持不变。
        assert_eq!(simplify_windows_path(Path::new(r"C:\lib\x.png")), Path::new(r"C:\lib\x.png"));
        // 未知命名空间（如 Volume GUID）不误伤。
        assert_eq!(
            simplify_windows_path(Path::new(r"\\?\Volume{1234}")),
            Path::new(r"\\?\Volume{1234}")
        );
        // 非 Windows 风格路径不受影响。
        assert_eq!(simplify_windows_path(Path::new("/home/a/b.png")), Path::new("/home/a/b.png"));
    }

    #[test]
    fn external_resource_files_can_be_restored_before_database_commit() {
        let (app, root) = test_app();
        let first = root.join("first.bin");
        let second = root.join("nested/second.bin");
        std::fs::create_dir_all(second.parent().unwrap()).unwrap();
        std::fs::write(&first, [1_u8, 2, 3]).unwrap();
        std::fs::write(&second, [4_u8, 5, 6]).unwrap();
        let ids = vec![resource_file_id(&first), resource_file_id(&second)];

        let staged = stage_external_resource_files(app.handle(), &ids).unwrap();
        assert!(!first.exists());
        assert!(!second.exists());
        restore_staged_external_resource_files(&staged);

        assert!(first.is_file());
        assert!(second.is_file());
        cleanup(&root);
    }

    #[test]
    fn renaming_resource_group_updates_files_and_record_metadata() {
        let (app, root) = test_app();
        let old_path = root.join("Old");
        let nested_path = old_path.join("archive");
        std::fs::create_dir_all(&nested_path).unwrap();
        let file = nested_path.join("copy-creator-resource-1.txt");
        std::fs::write(&file, "resource").unwrap();
        insert_resource(&app, "resource-1", 10.0, "Old", file.to_str().unwrap());

        update_resource_group_inner(app.handle(), "Old".to_string(), "New".to_string()).unwrap();

        let new_file = root.join("New/archive/copy-creator-resource-1.txt");
        assert!(new_file.is_file());
        assert!(!old_path.exists());
        let state = app.state::<DbState>();
        let conn = state.conn.lock().unwrap();
        let (group_name, resource_path): (String, String) = conn
            .query_row(
                "SELECT group_name, resource_path FROM clipboard_records WHERE id = 'resource-1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(group_name, "New");
        assert_eq!(
            slash_normalized(&resource_path),
            slash_normalized(&new_file.to_string_lossy())
        );
        cleanup(&root);
    }

    #[test]
    fn renaming_resource_file_updates_file_and_record_paths() {
        let (app, root) = test_app();
        let file = root.join("三视图/image_00014_.png");
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, [1_u8, 2, 3]).unwrap();
        insert_typed_resource(
            &app,
            "resource-1",
            "image",
            file.to_str().unwrap(),
            file.to_str().unwrap(),
        );

        let result = rename_resource_file_inner(
            app.handle(),
            "resource-1".to_string(),
            "林黛玉三视图".to_string(),
        )
        .unwrap();

        let renamed = root.join("三视图/林黛玉三视图.png");
        assert!(renamed.is_file());
        assert!(!file.exists());
        assert_eq!(
            slash_normalized(result["resource_path"].as_str().unwrap()),
            slash_normalized(&renamed.to_string_lossy())
        );
        assert_eq!(
            slash_normalized(result["content"].as_str().unwrap()),
            slash_normalized(&renamed.to_string_lossy())
        );
        assert_eq!(result["name"], "林黛玉三视图.png");
        assert_eq!(
            slash_normalized(result["resource_relative_path"].as_str().unwrap()),
            "三视图/林黛玉三视图.png"
        );
        let state = app.state::<DbState>();
        let conn = state.conn.lock().unwrap();
        let (content, resource_path): (String, String) = conn
            .query_row(
                "SELECT content, resource_path FROM clipboard_records WHERE id = 'resource-1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(slash_normalized(&resource_path), slash_normalized(&renamed.to_string_lossy()));
        assert_eq!(slash_normalized(&content), slash_normalized(&renamed.to_string_lossy()));
        cleanup(&root);
    }

    #[test]
    fn renaming_resource_file_keeps_extension_and_rejects_conflicts() {
        let (app, root) = test_app();
        let file = root.join("image_00014_.png");
        std::fs::write(&file, [1_u8, 2, 3]).unwrap();
        insert_typed_resource(
            &app,
            "resource-1",
            "file",
            file.to_str().unwrap(),
            file.to_str().unwrap(),
        );

        rename_resource_file_inner(
            app.handle(),
            "resource-1".to_string(),
            "林黛玉.PNG".to_string(),
        )
        .unwrap();
        assert!(root.join("林黛玉.png").is_file());
        assert!(!file.exists());

        let second = root.join("second.png");
        std::fs::write(&second, [4_u8, 5, 6]).unwrap();
        insert_typed_resource(
            &app,
            "resource-2",
            "file",
            second.to_str().unwrap(),
            second.to_str().unwrap(),
        );
        let error = rename_resource_file_inner(
            app.handle(),
            "resource-2".to_string(),
            "林黛玉.png".to_string(),
        )
        .unwrap_err();
        assert!(error.contains("已存在同名文件"));
        assert!(second.is_file());
        cleanup(&root);
    }

    #[test]
    fn renaming_discovered_resource_file_updates_promoted_record_and_content() {
        let (app, root) = test_app();
        let discovered = root.join("discovered.png");
        std::fs::write(&discovered, [1_u8, 2, 3]).unwrap();
        let result = rename_resource_file_inner(
            app.handle(),
            resource_file_id(&discovered),
            "新名字.png".to_string(),
        )
        .unwrap();
        let renamed = root.join("新名字.png");
        assert!(renamed.is_file());
        assert_eq!(
            slash_normalized(result["id"].as_str().unwrap()),
            slash_normalized(&resource_file_id(&renamed))
        );
        assert_eq!(
            slash_normalized(result["content"].as_str().unwrap()),
            slash_normalized(&renamed.to_string_lossy())
        );

        let promoted = root.join("promoted.png");
        std::fs::write(&promoted, [4_u8, 5, 6]).unwrap();
        insert_typed_resource(
            &app,
            &resource_file_id(&promoted),
            "file",
            promoted.to_str().unwrap(),
            promoted.to_str().unwrap(),
        );
        rename_resource_file_inner(
            app.handle(),
            resource_file_id(&promoted),
            "已入库.png".to_string(),
        )
        .unwrap();
        assert!(root.join("已入库.png").is_file());
        let state = app.state::<DbState>();
        let conn = state.conn.lock().unwrap();
        let resource_path: String = conn
            .query_row(
                "SELECT resource_path FROM clipboard_records WHERE id = ?1",
                [&resource_file_id(&promoted)],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(resource_path, root.join("已入库.png").to_string_lossy());
        cleanup(&root);
    }

    #[test]
    fn renaming_resource_file_rejects_plain_text_but_renames_file_backed_text() {
        let (app, root) = test_app();
        // 资源库文本记录（新建窗口写入的 .txt）：类型是 text，但有对应文件，可改名。
        let file = root.join("note.txt");
        std::fs::write(&file, "正文").unwrap();
        insert_typed_resource(
            &app,
            "text-1",
            "text",
            "正文内容",
            file.to_str().unwrap(),
        );
        let result = rename_resource_file_inner(
            app.handle(),
            "text-1".to_string(),
            "新标题.txt".to_string(),
        )
        .unwrap();
        let renamed = root.join("新标题.txt");
        assert!(renamed.is_file());
        assert!(!file.exists());
        // 正文（content）与标题解耦：改名只动文件名，不改写正文。
        assert_eq!(result["content"], "正文内容");
        let state = app.state::<DbState>();
        let (content, resource_path): (String, String) = {
            let conn = state.conn.lock().unwrap();
            conn.query_row(
                "SELECT content, resource_path FROM clipboard_records WHERE id = 'text-1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap()
        };
        assert_eq!(content, "正文内容");
        assert_eq!(
            slash_normalized(&resource_path),
            slash_normalized(&renamed.to_string_lossy())
        );
        drop(state);

        // 没有对应文件的纯文本记录：标题来自正文，仍拒绝改名。
        insert_typed_resource(&app, "text-2", "text", "纯文本", "");
        let error = rename_resource_file_inner(
            app.handle(),
            "text-2".to_string(),
            "新标题".to_string(),
        )
        .unwrap_err();
        assert!(error.contains("不支持重命名"));

        let image = root.join("image.png");
        std::fs::write(&image, [1_u8]).unwrap();
        assert!(validate_resource_rename_stem("", Path::new("/tmp/a.png")).is_err());
        assert!(validate_resource_rename_stem("a/b", Path::new("/tmp/a.png")).is_err());
        assert!(validate_resource_rename_stem("a\\b", Path::new("/tmp/a.png")).is_err());
        assert!(validate_resource_rename_stem("CON", Path::new("/tmp/a.png")).is_err());
        assert!(validate_resource_rename_stem(".hidden", Path::new("/tmp/a.png")).is_err());
        assert_eq!(
            validate_resource_rename_stem("三视图.png", Path::new("/tmp/a.png")).unwrap(),
            "三视图"
        );
        assert_eq!(
            validate_resource_rename_stem("  三视图  ", Path::new("/tmp/a.png")).unwrap(),
            "三视图"
        );
        assert_eq!(
            validate_resource_rename_stem("名字", Path::new("/tmp/a.png")).unwrap(),
            "名字"
        );
        cleanup(&root);
    }

    #[test]
    fn moving_resource_records_updates_files_records_and_markdown_links() {
        let (app, root) = test_app();
        let attachments = root.join(".copy-creator/attachments/unit-1");
        std::fs::create_dir_all(&attachments).unwrap();
        std::fs::write(attachments.join("image-1.png"), [1_u8]).unwrap();
        let md_file = root.join("工作资料/角色/note.md");
        std::fs::create_dir_all(md_file.parent().unwrap()).unwrap();
        std::fs::write(&md_file, "图：![img](../../.copy-creator/attachments/unit-1/image-1.png)\n")
            .unwrap();
        insert_typed_resource(
            &app,
            "resource-1",
            "file",
            md_file.to_str().unwrap(),
            md_file.to_str().unwrap(),
        );
        let plain_file = root.join("工作资料/plain.txt");
        std::fs::write(&plain_file, "text").unwrap();
        insert_typed_resource(
            &app,
            "resource-2",
            "file",
            plain_file.to_str().unwrap(),
            plain_file.to_str().unwrap(),
        );

        let results = move_resource_records_inner(
            app.handle(),
            vec!["resource-1".to_string(), "resource-2".to_string()],
            String::new(),
        )
        .unwrap();

        assert_eq!(results.len(), 2);
        let moved_md = root.join("note.md");
        let moved_plain = root.join("plain.txt");
        assert!(moved_md.is_file());
        assert!(moved_plain.is_file());
        assert!(!md_file.exists());
        let content = std::fs::read_to_string(&moved_md).unwrap();
        assert_eq!(
            content,
            "图：![img](.copy-creator/attachments/unit-1/image-1.png)\n"
        );

        let state = app.state::<DbState>();
        let conn = state.conn.lock().unwrap();
        let (group_name, resource_path): (String, String) = conn
            .query_row(
                "SELECT group_name, resource_path FROM clipboard_records WHERE id = 'resource-2'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(group_name, "");
        assert_eq!(slash_normalized(&resource_path), slash_normalized(&moved_plain.to_string_lossy()));
        cleanup(&root);
    }

    #[test]
    fn moving_resource_records_rejects_conflicts_and_rolls_back() {
        let (app, root) = test_app();
        let first = root.join("工作资料/a.txt");
        let second = root.join("工作资料/b.txt");
        std::fs::create_dir_all(first.parent().unwrap()).unwrap();
        std::fs::create_dir_all(root.join("项目资料")).unwrap();
        std::fs::write(&first, "a").unwrap();
        std::fs::write(&second, "b").unwrap();
        std::fs::write(root.join("项目资料/a.txt"), "conflict").unwrap();
        insert_typed_resource(
            &app,
            "resource-1",
            "file",
            first.to_str().unwrap(),
            first.to_str().unwrap(),
        );
        insert_typed_resource(
            &app,
            "resource-2",
            "file",
            second.to_str().unwrap(),
            second.to_str().unwrap(),
        );

        let error = move_resource_records_inner(
            app.handle(),
            vec!["resource-1".to_string(), "resource-2".to_string()],
            "项目资料".to_string(),
        )
        .unwrap_err();
        assert!(error.contains("已存在同名文件"));
        assert!(first.is_file());
        assert!(second.is_file());
        assert!(!root.join("项目资料/b.txt").exists());
        let state = app.state::<DbState>();
        let conn = state.conn.lock().unwrap();
        let resource_path: String = conn
            .query_row(
                "SELECT resource_path FROM clipboard_records WHERE id = 'resource-1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(resource_path, first.to_string_lossy());
        cleanup(&root);
    }

    #[test]
    fn moving_discovered_resource_files_returns_new_ids() {
        let (app, root) = test_app();
        let discovered = root.join("未入库.png");
        std::fs::write(&discovered, [1_u8]).unwrap();

        let results = move_resource_records_inner(
            app.handle(),
            vec![resource_file_id(&discovered)],
            "工作资料/角色".to_string(),
        )
        .unwrap();

        let moved = root.join("工作资料/角色/未入库.png");
        assert!(moved.is_file());
        assert!(!discovered.exists());
        assert_eq!(results.len(), 1);
        assert_eq!(
            slash_normalized(results[0]["id"].as_str().unwrap()),
            slash_normalized(&resource_file_id(&moved))
        );
        assert_eq!(results[0]["resource_folder"], "工作资料/角色");
        assert_eq!(
            slash_normalized(results[0]["content"].as_str().unwrap()),
            slash_normalized(&moved.to_string_lossy())
        );
        cleanup(&root);
    }

    #[test]
    fn moving_resource_records_into_same_folder_is_a_no_op() {
        let (app, root) = test_app();
        let file = root.join("工作资料/a.txt");
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, "a").unwrap();
        insert_typed_resource(
            &app,
            "resource-1",
            "file",
            file.to_str().unwrap(),
            file.to_str().unwrap(),
        );

        let results = move_resource_records_inner(
            app.handle(),
            vec!["resource-1".to_string()],
            "工作资料".to_string(),
        )
        .unwrap();
        assert_eq!(results.len(), 1);
        assert!(file.is_file());
        assert_eq!(
            slash_normalized(results[0]["resource_relative_path"].as_str().unwrap()),
            "工作资料/a.txt"
        );
        cleanup(&root);
    }

    #[test]
    fn moving_resource_records_rejects_duplicate_names_within_selection() {
        let (app, root) = test_app();
        let first = root.join("工作资料/a.txt");
        let second = root.join("项目资料/a.txt");
        std::fs::create_dir_all(first.parent().unwrap()).unwrap();
        std::fs::create_dir_all(second.parent().unwrap()).unwrap();
        std::fs::write(&first, "a").unwrap();
        std::fs::write(&second, "b").unwrap();
        insert_typed_resource(
            &app,
            "resource-1",
            "file",
            first.to_str().unwrap(),
            first.to_str().unwrap(),
        );
        insert_typed_resource(
            &app,
            "resource-2",
            "file",
            second.to_str().unwrap(),
            second.to_str().unwrap(),
        );

        let error = move_resource_records_inner(
            app.handle(),
            vec!["resource-1".to_string(), "resource-2".to_string()],
            "归档".to_string(),
        )
        .unwrap_err();
        assert!(error.contains("同名文件"));
        assert!(first.is_file());
        assert!(second.is_file());
        cleanup(&root);
    }

    #[test]
    fn deleting_resource_group_moves_files_updates_markdown_and_clears_metadata() {
        let (app, root) = test_app();
        let group_path = root.join("References");
        let attachments = root.join(".copy-creator/attachments/resource-1-transaction");
        std::fs::create_dir_all(&attachments).unwrap();
        std::fs::create_dir_all(&group_path).unwrap();
        let file = group_path.join("copy-creator-resource-1.md");
        std::fs::write(
            &file,
            "截图\n![截图 1](../.copy-creator/attachments/resource-1-transaction/image-1.png)\n",
        )
        .unwrap();
        insert_resource(
            &app,
            "resource-1",
            10.0,
            "References",
            file.to_str().unwrap(),
        );

        delete_resource_group_inner(app.handle(), "References".to_string()).unwrap();

        let moved_file = root.join("copy-creator-resource-1.md");
        assert!(moved_file.is_file());
        assert!(!group_path.exists());
        assert_eq!(
            std::fs::read_to_string(&moved_file).unwrap(),
            "截图\n![截图 1](.copy-creator/attachments/resource-1-transaction/image-1.png)\n",
        );
        let state = app.state::<DbState>();
        let conn = state.conn.lock().unwrap();
        let (group_name, resource_path): (String, String) = conn
            .query_row(
                "SELECT group_name, resource_path FROM clipboard_records WHERE id = 'resource-1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert!(group_name.is_empty());
        assert_eq!(resource_path, moved_file.to_string_lossy());
        cleanup(&root);
    }

    #[test]
    fn deleting_resource_group_preserves_nested_paths_and_adjusts_nested_markdown_links() {
        let (app, root) = test_app();
        let group_path = root.join("References");
        let nested_path = group_path.join("archive/deep");
        std::fs::create_dir_all(&nested_path).unwrap();
        let file = nested_path.join("resource.md");
        std::fs::write(
            &file,
            "截图\n![截图 1](../../../.copy-creator/attachments/image-1.png)\n",
        )
        .unwrap();

        delete_resource_group_inner(app.handle(), "References".to_string()).unwrap();

        let moved_file = root.join("archive/deep/resource.md");
        assert!(moved_file.is_file());
        assert_eq!(
            std::fs::read_to_string(moved_file).unwrap(),
            "截图\n![截图 1](../../.copy-creator/attachments/image-1.png)\n",
        );
        assert!(!group_path.exists());
        cleanup(&root);
    }

    #[test]
    fn deleting_resource_group_rolls_back_previous_moves_when_markdown_read_fails() {
        let (app, root) = test_app();
        let group_path = root.join("References");
        std::fs::create_dir_all(&group_path).unwrap();
        let first = group_path.join("01-resource.txt");
        let unreadable_markdown = group_path.join("02-resource.md");
        std::fs::write(&first, "resource").unwrap();
        std::fs::write(&unreadable_markdown, [0xff, 0xfe, 0xfd]).unwrap();

        let error = delete_resource_group_inner(app.handle(), "References".to_string())
            .expect_err("无效 UTF-8 的 Markdown 文件应使分组删除失败");
        assert!(error.contains("读取资源文件失败"));
        assert!(first.is_file());
        assert!(unreadable_markdown.is_file());
        assert!(!root.join("01-resource.txt").exists());
        assert!(root.join("References").is_dir());
        cleanup(&root);
    }

    #[test]
    fn save_stash_record_custom_resource_name() {
        // 新建窗口资源命名：填名称按名称落盘；重名报错；编辑保存同名
        // 覆盖自身旧文件不误报冲突。
        let (app, root) = test_app();
        let group = root.join("分镜提词");
        std::fs::create_dir_all(&group).unwrap();

        let result = crate::clipboard::save_stash_record_inner(
            app.handle(),
            None,
            "命名内容".to_string(),
            Vec::new(),
            Some("resource".to_string()),
            Some("分镜提词".to_string()),
            Some("我的提示词".to_string()),
        )
        .unwrap();
        let path = Path::new(result["resource_path"].as_str().unwrap());
        assert_eq!(path.file_name().unwrap().to_str().unwrap(), "我的提示词.txt");
        assert!(path.is_file());

        let conflict = crate::clipboard::save_stash_record_inner(
            app.handle(),
            None,
            "另一段内容".to_string(),
            Vec::new(),
            Some("resource".to_string()),
            Some("分镜提词".to_string()),
            Some("我的提示词".to_string()),
        );
        assert!(conflict.is_err(), "同组同名资源应报冲突");
        // 命名失败必须回滚已写入的管理文件：残留会被资源发现收录成幽灵条目。
        let orphans: Vec<String> = std::fs::read_dir(&group)
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .filter(|name| name.starts_with("copy-creator-") || name.starts_with('.'))
            .collect();
        assert!(orphans.is_empty(), "命名失败不应残留管理/临时文件: {orphans:?}");
        assert_eq!(
            std::fs::read_dir(&group).unwrap().flatten().count(),
            1,
            "分组内应只剩首次保存的命名文件"
        );

        let record_id = result["id"].as_str().unwrap().to_string();
        let updated = crate::clipboard::save_stash_record_inner(
            app.handle(),
            Some(record_id),
            "改后的内容".to_string(),
            Vec::new(),
            Some("resource".to_string()),
            Some("分镜提词".to_string()),
            Some("我的提示词".to_string()),
        )
        .unwrap();
        assert!(Path::new(updated["resource_path"].as_str().unwrap()).is_file());
    }

    #[test]
    fn save_stash_record_accepts_nested_group_path() {
        // 新建窗口分组选择器传完整分组路径；单级名校验会误拒子分组保存。
        let (app, root) = test_app();
        let nested = root.join("分镜提词").join("seedance");
        std::fs::create_dir_all(&nested).unwrap();

        let result = crate::clipboard::save_stash_record_inner(
            app.handle(),
            None,
            "嵌套分组内容".to_string(),
            Vec::new(),
            Some("resource".to_string()),
            Some("分镜提词/seedance".to_string()),
            None,
        )
        .unwrap();

        assert_eq!(result["resource_group"], "分镜提词/seedance");
        let resource_path = Path::new(result["resource_path"].as_str().unwrap());
        assert!(resource_path.starts_with(&nested));
        assert!(resource_path.is_file());

        let state = app.state::<DbState>();
        let conn = state.conn.lock().unwrap();
        let (group_name, storage_mode): (String, String) = conn
            .query_row(
                "SELECT group_name, storage_mode FROM clipboard_records WHERE id = ?1",
                [result["id"].as_str().unwrap()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(group_name, "分镜提词/seedance");
        assert_eq!(storage_mode, "resource");
        cleanup(&root);
    }

    #[test]
    fn save_stash_record_nested_group_image_links_match_depth() {
        // 附件存放在资源库根目录 .copy-creator 下，二级分组的相对前缀应为 ../../。
        let (app, root) = test_app();
        let nested = root.join("a").join("b");
        std::fs::create_dir_all(&nested).unwrap();
        let mut png = std::io::Cursor::new(Vec::new());
        image::RgbaImage::from_pixel(1, 1, image::Rgba([255u8, 0, 0, 255]))
            .write_to(&mut png, image::ImageFormat::Png)
            .unwrap();
        use base64::Engine as _;
        let data_url = format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(png.into_inner())
        );

        let result = crate::clipboard::save_stash_record_inner(
            app.handle(),
            None,
            "\u{FFFC}".to_string(),
            vec![data_url],
            Some("resource".to_string()),
            Some("a/b".to_string()),
            None,
        )
        .unwrap();

        let markdown = std::fs::read_to_string(result["resource_path"].as_str().unwrap()).unwrap();
        assert!(
            markdown.contains("../../.copy-creator/attachments/"),
            "markdown 应包含两级相对前缀: {markdown}"
        );
        cleanup(&root);
    }

    #[test]
    fn touch_resource_group_usage_covers_nested_subgroups_only() {
        let (app, root) = test_app();
        let mut paths = Vec::new();
        for relative in ["a/one.txt", "a/b/two.txt", "c/three.txt"] {
            let path = root.join(relative);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, [1_u8, 2, 3]).unwrap();
            paths.push(path);
        }
        // discovered.png 只存在于文件系统（未入库），库中无对应行。
        // 逐级 join 保证与扫描器产物的路径形态一致。
        let discovered = root.join("a").join("discovered.png");
        std::fs::write(&discovered, [1_u8, 2, 3]).unwrap();
        insert_resource(&app, "in-a", 1.0, "a", paths[0].to_str().unwrap());
        insert_resource(&app, "in-a-b", 2.0, "a", paths[1].to_str().unwrap());
        insert_resource(&app, "in-c", 3.0, "c", paths[2].to_str().unwrap());

        crate::db::touch_resource_group_usage_internal(app.handle(), "a").unwrap();

        let state = app.state::<DbState>();
        let conn = state.conn.lock().unwrap();
        let touched: Vec<String> = conn
            .prepare("SELECT id FROM clipboard_records WHERE COALESCE(last_used_at, '') <> ''")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        // 未入库的 discovered.png 应被补建记录并计入；c 分组不受影响。
        assert_eq!(
            touched,
            vec![
                "in-a".to_string(),
                "in-a-b".to_string(),
                crate::db::resource_file_id(&discovered)
            ]
        );
        cleanup(&root);
    }

    #[test]
    fn touch_clipboard_usage_promotes_discovered_resource() {
        // 单击粘贴未入库资源（resource-file: 虚拟 id）也应计入「最近使用」。
        let (app, root) = test_app();
        let file = root.join("gpt-image.png");
        std::fs::write(&file, [1_u8, 2, 3]).unwrap();
        let id = resource_file_id(&file);

        crate::db::touch_clipboard_usage_internal(app.handle(), &[id.clone()]).unwrap();

        let state = app.state::<DbState>();
        let conn = state.conn.lock().unwrap();
        let (storage_mode, resource_path): (String, String) = conn
            .query_row(
                "SELECT storage_mode, resource_path FROM clipboard_records WHERE id = ?1",
                [&id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(storage_mode, "resource");
        assert_eq!(resource_path, file.to_string_lossy());
        let last_used_at: String = conn
            .query_row(
                "SELECT last_used_at FROM clipboard_records WHERE id = ?1",
                [&id],
                |row| row.get(0),
            )
            .unwrap();
        assert!(!last_used_at.is_empty());
        cleanup(&root);
    }

    #[test]
    fn full_user_journey_across_sort_and_sync_features() {
        // 真人会话模拟：复制 → 粘贴 → 切排序模式 → 外部移入 → 外部删除
        // → 自愈 → 短语粘贴 → 删除记录。逐步断言各优化点的行为。
        let (app, root) = test_app();
        let handle = app.handle().clone();
        {
            let state = app.state::<DbState>();
            let conn = state.conn.lock().unwrap();
            conn.execute_batch(
                "CREATE TABLE IF NOT EXISTS api_key_labels (
                     record_id TEXT PRIMARY KEY, service TEXT NOT NULL,
                     api_base TEXT DEFAULT '', note TEXT DEFAULT '',
                     is_expired INTEGER DEFAULT 0, created_at TEXT NOT NULL
                 );
                 CREATE TABLE phrase_groups (
                     id TEXT PRIMARY KEY, name TEXT NOT NULL, sort_order INTEGER DEFAULT 0,
                     created_at TEXT NOT NULL, updated_at TEXT NOT NULL
                 );
                 CREATE TABLE phrases (
                     id TEXT PRIMARY KEY, group_id TEXT NOT NULL, title TEXT NOT NULL,
                     content TEXT NOT NULL, input_type TEXT DEFAULT 'text',
                     source_path TEXT DEFAULT '', file_size INTEGER DEFAULT 0,
                     sort_order INTEGER DEFAULT 0, created_at TEXT NOT NULL,
                     updated_at TEXT NOT NULL, last_used_at TEXT DEFAULT '',
                     last_used_ms INTEGER GENERATED ALWAYS AS (CAST((julianday(last_used_at) - 2440587.5) * 86400000 AS INTEGER)) VIRTUAL,
                     use_count INTEGER DEFAULT 0
                 );
                 INSERT INTO clipboard_records (id, type, content, created_at, sort_order)
                 VALUES ('c1', 'text', '第一条', '2026-09-12T08:00:00Z', 1000.0),
                        ('c2', 'text', '第二条', '2026-09-12T08:01:00Z', 2000.0),
                        ('c3', 'text', '第三条', '2026-09-12T08:02:00Z', 3000.0);
                 INSERT INTO phrase_groups (id, name, created_at, updated_at)
                 VALUES ('g1', '客服话术', '2026-09-12T08:00:00Z', '2026-09-12T08:00:00Z');
                 INSERT INTO phrases (id, group_id, title, content, created_at, updated_at)
                 VALUES ('p1', 'g1', 't', '您好', '2026-09-12T08:00:00Z', '2026-09-12T08:00:00Z'),
                        ('p2', 'g1', 't', '请查收', '2026-09-12T08:01:00Z', '2026-09-12T08:01:00Z');",
            )
            .unwrap();
        }

        let clipboard_ids = |sort_by: &str| -> Vec<String> {
            ids_of(
                &get_clipboard_records_inner(
                    &handle,
                    None,
                    Some(50),
                    Some(0),
                    None,
                    None,
                    Some(sort_by.to_string()),
                )
                .unwrap(),
            )
        };
        let resource_ids = |sort_by: &str| -> Vec<String> {
            ids_of(
                &get_clipboard_records_inner(
                    &handle,
                    None,
                    Some(50),
                    Some(0),
                    Some("resources".to_string()),
                    None,
                    Some(sort_by.to_string()),
                )
                .unwrap(),
            )
        };

        // ── 步骤 1：把第一条粘贴两次 ──
        crate::db::touch_clipboard_usage_internal(&handle, &["c1".to_string()]).unwrap();
        std::thread::sleep(Duration::from_millis(3));
        crate::db::touch_clipboard_usage_internal(&handle, &["c1".to_string()]).unwrap();

        // 最近使用：刚粘贴的置顶，其余按复制时间。
        assert_eq!(clipboard_ids("recent"), vec!["c1", "c3", "c2"]);
        // 最多使用：2 次的第一，未使用的按复制时间。
        assert_eq!(clipboard_ids("count"), vec!["c1", "c3", "c2"]);

        // ── 步骤 2：外部移入两个文件（复制与移动各一）──
        let copied = root.join("copied.png");
        let moved = root.join("moved.md");
        std::fs::write(&copied, [1]).unwrap();
        std::fs::write(&moved, b"md").unwrap();
        crate::db::discover_external_resource_files(&handle, &[copied.clone(), moved.clone()]);

        let after_arrival = resource_ids("recent");
        assert_eq!(after_arrival.len(), 2);
        assert!(after_arrival.contains(&crate::db::resource_file_id(&copied)));
        assert!(after_arrival.contains(&crate::db::resource_file_id(&moved)));
        // 最多使用：零使用的移入文件在未使用区顶部（库内暂无其他资源）；
        // 两者发现时间相同，先后由 id 决胜，断言集合即可。
        let after_arrival_count = resource_ids("count");
        assert_eq!(after_arrival_count.len(), 2);
        assert!(after_arrival_count.contains(&crate::db::resource_file_id(&copied)));
        assert!(after_arrival_count.contains(&crate::db::resource_file_id(&moved)));

        // ── 步骤 3：文件管理器删除其中一个 → 对账/监听删除自愈 ──
        std::fs::remove_file(&copied).unwrap();
        crate::db::sync_resource_library(app.handle());
        assert_eq!(
            resource_ids("recent"),
            vec![crate::db::resource_file_id(&moved)]
        );

        // ── 步骤 4：使用剩下的资源一次 ──
        let moved_id = crate::db::resource_file_id(&moved);
        crate::db::touch_clipboard_usage_internal(&handle, &[moved_id.clone()]).unwrap();
        assert_eq!(resource_ids("count"), vec![moved_id]);

        // ── 步骤 5：粘贴一条短语两次，快捷输入「全部」两种模式 ──
        crate::db::touch_phrase_usage_internal(&handle, "p2").unwrap();
        crate::db::touch_phrase_usage_internal(&handle, "p2").unwrap();
        let phrases_recent =
            crate::db::get_all_phrases(handle.clone(), None, Some("recent".into())).unwrap();
        assert_eq!(
            phrases_recent
                .iter()
                .map(|p| p["id"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec!["p2", "p1"]
        );
        let phrases_count =
            crate::db::get_all_phrases(handle.clone(), None, Some("count".into())).unwrap();
        assert_eq!(
            phrases_count
                .iter()
                .map(|p| p["id"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec!["p2", "p1"]
        );

        // ── 步骤 6：删除一条剪切板记录（含使用记录）──
        crate::db::delete_clipboard_records_internal(&handle, &["c2".to_string()]).unwrap();
        assert_eq!(clipboard_ids("count"), vec!["c1", "c3"]);

        cleanup(&root);
    }

    fn ids_of(records: &[serde_json::Value]) -> Vec<String> {
        records
            .iter()
            .map(|r| r["id"].as_str().unwrap_or("").to_string())
            .collect()
    }

    #[test]
    fn content_sort_applies_to_every_all_view() {
        // 全区「全部」视图的按面验证：剪切板全部、资源全部分组、快捷输入全部
        // 两种模式都必须按预期排序（分组浏览不在此列，前端不传偏好）。
        let (app, root) = test_app();
        {
            let state = app.state::<DbState>();
            let conn = state.conn.lock().unwrap();
            conn.execute_batch(
                "CREATE TABLE phrase_groups (
                     id TEXT PRIMARY KEY, name TEXT NOT NULL, sort_order INTEGER DEFAULT 0,
                     created_at TEXT NOT NULL, updated_at TEXT NOT NULL
                 );
                 CREATE TABLE phrases (
                     id TEXT PRIMARY KEY, group_id TEXT NOT NULL, title TEXT NOT NULL,
                     content TEXT NOT NULL, input_type TEXT DEFAULT 'text',
                     source_path TEXT DEFAULT '', file_size INTEGER DEFAULT 0,
                     sort_order INTEGER DEFAULT 0, created_at TEXT NOT NULL,
                     updated_at TEXT NOT NULL, last_used_at TEXT DEFAULT '',
                     last_used_ms INTEGER GENERATED ALWAYS AS (CAST((julianday(last_used_at) - 2440587.5) * 86400000 AS INTEGER)) VIRTUAL,
                     use_count INTEGER DEFAULT 0
                 );",
            )
            .unwrap();
            // 剪切板：fresh-copy 最新复制未使用；just-used 复制最早但刚用过。
            conn.execute(
                "INSERT INTO clipboard_records (id, type, content, created_at, sort_order, touched_ms, use_count)
                 VALUES ('fresh-copy', 'text', '新复制', '2026-09-11T08:00:00Z', 3000.0, 0, 0),
                        ('just-used', 'text', '刚用过', '2026-09-09T08:00:00Z', 1000.0, 2500, 1)",
                [],
            )
            .unwrap();
            // 短语：hot 用过 5 次，fresh 短语未使用。
            conn.execute(
                "INSERT INTO phrase_groups (id, name, created_at, updated_at)
                 VALUES ('g1', '分组', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z')",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO phrases (id, group_id, title, content, created_at, updated_at, last_used_at, use_count)
                 VALUES ('phrase-hot', 'g1', 't', '高频短语', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z', '2026-09-05T10:00:00Z', 5),
                        ('phrase-fresh', 'g1', 't', '新短语', '2026-09-06T00:00:00Z', '2026-09-06T00:00:00Z', '', 0)",
                [],
            )
            .unwrap();
        }
        // 资源记录：used.png 修改时间早但被用过，fresh.png 修改时间最新。
        let used = root.join("used.png");
        let fresh = root.join("fresh.png");
        std::fs::write(&used, [1, 2, 3]).unwrap();
        std::fs::write(&fresh, [4, 5, 6]).unwrap();
        insert_resource(&app, "res-used", 1000.0, "", used.to_str().unwrap());
        insert_resource(&app, "res-fresh", 3000.0, "", fresh.to_str().unwrap());
        {
            let state = app.state::<DbState>();
            let conn = state.conn.lock().unwrap();
            conn.execute(
                "UPDATE clipboard_records SET touched_ms = 2500, use_count = 2 WHERE id = 'res-used'",
                [],
            )
            .unwrap();
        }

        let ids = |records: &[serde_json::Value]| -> Vec<String> {
            records
                .iter()
                .map(|r| r["id"].as_str().unwrap_or("").to_string())
                .collect()
        };
        let handle = app.handle().clone();

        // 剪切板「全部」：最多使用 → 次数倒序；最近使用 → 新复制置顶、刚用过的上浮。
        let clipboard_count = get_clipboard_records_inner(
            &handle, None, Some(50), Some(0), None, None, Some("count".into()),
        )
        .unwrap();
        assert_eq!(ids(&clipboard_count), vec!["just-used", "fresh-copy"]);
        let clipboard_recent = get_clipboard_records_inner(
            &handle, None, Some(50), Some(0), None, None, Some("recent".into()),
        )
        .unwrap();
        assert_eq!(ids(&clipboard_recent), vec!["fresh-copy", "just-used"]);

        // 资源「全部分组」：最多使用 → 被用过的在前；最近使用 → 刚改的文件在前。
        let resources_count = get_clipboard_records_inner(
            &handle, None, Some(50), Some(0), Some("resources".into()), None, Some("count".into()),
        )
        .unwrap();
        assert_eq!(ids(&resources_count), vec!["res-used", "res-fresh"]);
        let resources_recent = get_clipboard_records_inner(
            &handle, None, Some(50), Some(0), Some("resources".into()), None, Some("recent".into()),
        )
        .unwrap();
        assert_eq!(ids(&resources_recent), vec!["res-fresh", "res-used"]);

        // 快捷输入「全部」：最多使用 → 次数倒序、未使用垫底。
        let phrases_count = crate::db::get_all_phrases(handle.clone(), None, Some("count".into())).unwrap();
        assert_eq!(ids(&phrases_count), vec!["phrase-hot", "phrase-fresh"]);
        let phrases_recent = crate::db::get_all_phrases(handle, None, Some("recent".into())).unwrap();
        assert_eq!(ids(&phrases_recent), vec!["phrase-hot", "phrase-fresh"]);

        cleanup(&root);
    }

    #[test]
    fn resource_scan_prunes_rows_for_externally_deleted_files() {
        // 外部（文件管理器）删除文件后：启动/切换对账清退其记录（运行期
        // 由监听 Vanished 事件实时清理），列表不再残留僵尸条目。
        let (app, root) = test_app();
        insert_resource(&app, "res-stay", 1000.0, "", root.join("stay.png").to_str().unwrap());
        std::fs::write(root.join("stay.png"), [1]).unwrap();
        insert_resource(&app, "res-gone", 2000.0, "", root.join("gone.png").to_str().unwrap());
        std::fs::write(root.join("gone.png"), [2]).unwrap();
        std::fs::remove_file(root.join("gone.png")).unwrap();
        crate::db::sync_resource_library(app.handle());

        let records = get_clipboard_records_inner(
            &app.handle().clone(),
            None,
            Some(50),
            Some(0),
            Some("resources".to_string()),
            None,
            None,
        )
        .unwrap();
        assert_eq!(
            records
                .iter()
                .map(|r| r["id"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec!["res-stay"]
        );

        let state = app.state::<DbState>();
        let conn = state.conn.lock().unwrap();
        let gone_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM clipboard_records WHERE id = 'res-gone'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(gone_count, 0);
        cleanup(&root);
    }

    #[test]
    fn delete_tolerates_externally_deleted_resource_files() {
        // 文件已被外部删除时，应用内点击删除应成功清理记录（解析失败
        // 视同文件已不在，不再让整个删除命令失败）。
        let (app, root) = test_app();
        let file = root.join("pinned-then-deleted.md");
        std::fs::write(&file, b"content").unwrap();
        {
            let state = app.state::<DbState>();
            let conn = state.conn.lock().unwrap();
            conn.execute_batch(
                "CREATE TABLE IF NOT EXISTS api_key_labels (
                     record_id TEXT PRIMARY KEY,
                     service TEXT NOT NULL,
                     api_base TEXT DEFAULT '',
                     note TEXT DEFAULT '',
                     is_expired INTEGER DEFAULT 0,
                     created_at TEXT NOT NULL
                 );",
            )
            .unwrap();
        }
        crate::db::discover_external_resource_files(app.handle(), &[file.clone()]);
        std::fs::remove_file(&file).unwrap();

        let id = crate::db::resource_file_id(&file);
        crate::db::delete_clipboard_records_internal(app.handle(), &[id]).unwrap();

        let state = app.state::<DbState>();
        let conn = state.conn.lock().unwrap();
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM clipboard_records WHERE resource_path = ?1",
                [file.to_string_lossy().as_ref()],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 0);
        cleanup(&root);
    }

    #[test]
    fn thumbs_directories_are_never_indexed_as_content() {
        // thumbs/ 是应用派生缓存：扫描不得收录（含嵌套 thumbs/thumbs），
        // 否则缩略图会以「原图」身份混进资源库。
        let root = std::env::temp_dir().join(format!(
            "copy-creator-resource-thumbs-scan-test-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(root.join("人物视图/thumbs/thumbs")).unwrap();
        std::fs::write(root.join("人物视图/original.png"), [1, 2, 3]).unwrap();
        std::fs::write(root.join("人物视图/thumbs/original.png"), [4]).unwrap();
        std::fs::write(root.join("人物视图/thumbs/thumbs/original.png"), [5]).unwrap();

        let entries = crate::db::scan_resource_files(&root);
        let relative_paths = entries
            .iter()
            .map(|entry| {
                entry
                    .path
                    .strip_prefix(&root)
                    .unwrap()
                    .to_string_lossy()
                    .to_string()
                    .replace('\\', "/")
            })
            .collect::<Vec<_>>();
        assert_eq!(relative_paths, vec!["人物视图/original.png"]);
    }

    #[test]
    fn discover_external_resource_files_skips_thumbs_and_prunes_legacy_rows() {
        // 监听补建不得收录 thumbs/ 缓存文件；历史版本误入库的 thumbs 记录
        // 在发现流程中被清退（文件保留在磁盘，仅移除入库记录）。
        let (app, root) = test_app();
        let legacy = root.join("人物视图/thumbs/legacy.png");
        std::fs::create_dir_all(legacy.parent().unwrap()).unwrap();
        std::fs::write(&legacy, [1]).unwrap();
        insert_resource(&app, "res-legacy-thumb", 3000.0, "", legacy.to_str().unwrap());

        let fresh = root.join("fresh.md");
        std::fs::write(&fresh, b"fresh").unwrap();
        crate::db::discover_external_resource_files(app.handle(), &[fresh, legacy]);

        let records = get_clipboard_records_inner(
            &app.handle().clone(),
            None,
            Some(50),
            Some(0),
            Some("resources".to_string()),
            None,
            Some("recent".into()),
        )
        .unwrap();
        assert!(!records.iter().any(|record| {
            record["resource_path"]
                .as_str()
                .is_some_and(|path| path.contains("thumbs"))
        }));
        assert_eq!(records.len(), 1);
        assert_eq!(
            records[0]["resource_path"].as_str(),
            Some(root.join("fresh.md").to_str().unwrap())
        );
    }

    #[test]
    fn sync_resource_library_inserts_missing_and_prunes_ghosts() {
        // 对账语义：应用未运行期间放入的文件按扫描语义补录（created_at/
        // sort_order 取文件修改时间，不置顶）；库内文件已被删除的记录清退；
        // 既有记录的 sort_order（发现时刻置顶语义）不被覆盖。
        let (app, root) = test_app();
        let existing = root.join("kept.png");
        std::fs::write(&existing, [1, 2, 3]).unwrap();
        insert_resource(&app, "res-kept", 5000.0, "", existing.to_str().unwrap());
        insert_resource(&app, "res-ghost", 3000.0, "", root.join("gone.png").to_str().unwrap());

        let newcomer = root.join("人物视图/new.png");
        std::fs::create_dir_all(newcomer.parent().unwrap()).unwrap();
        std::fs::write(&newcomer, [9, 9, 9]).unwrap();
        let file_time = chrono::DateTime::<chrono::Utc>::from(std::fs::metadata(&newcomer).unwrap().modified().unwrap()).to_rfc3339();

        let added = crate::db::sync_resource_library(app.handle());
        assert!(added >= 1);

        let records = get_clipboard_records_inner(
            &app.handle().clone(),
            None,
            Some(50),
            Some(0),
            Some("resources".to_string()),
            None,
            Some("recent".into()),
        )
        .unwrap();
        let paths: Vec<&str> = records
            .iter()
            .filter_map(|r| r["resource_path"].as_str())
            .collect();
        assert!(!paths.iter().any(|p| p.contains("gone.png")), "幽灵记录应被清退");
        assert!(paths.iter().any(|p| p.ends_with("kept.png")), "既有记录保留");
        assert!(paths.iter().any(|p| p.ends_with("new.png")), "新文件已补录");
        let newcomer_record = records
            .iter()
            .find(|r| r["resource_path"].as_str().is_some_and(|p| p.ends_with("new.png")))
            .unwrap();
        assert_eq!(newcomer_record["created_at"].as_str(), Some(file_time.as_str()));
        // 既有记录 sort_order 保持（发现时刻置顶语义不被对账覆盖）。
        assert_eq!(records.iter().find(|r| r["id"].as_str() == Some("res-kept")).is_some(), true);
    }

    #[test]
    fn forget_resource_records_removes_rows_for_deleted_paths() {
        let (app, root) = test_app();
        let target = root.join("doomed.png");
        std::fs::write(&target, [1]).unwrap();
        insert_resource(&app, "res-doomed", 1000.0, "", target.to_str().unwrap());
        let keeper = root.join("safe.png");
        std::fs::write(&keeper, [2]).unwrap();
        insert_resource(&app, "res-safe", 1000.0, "", keeper.to_str().unwrap());

        crate::db::forget_resource_records(app.handle(), &[target]);

        let records = get_clipboard_records_inner(
            &app.handle().clone(),
            None,
            Some(50),
            Some(0),
            Some("resources".to_string()),
            None,
            Some("recent".into()),
        )
        .unwrap();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0]["id"].as_str(), Some("res-safe"));
    }

    #[test]
    fn discover_external_resource_files_pins_newcomers_at_top() {
        // 外部移入资源库的新文件按发现时间入库置顶：库外路径、已存在记录、
        // 不存在的路径跳过；重复调用不重复入库。
        let (app, root) = test_app();
        insert_resource(&app, "res-old", 3000.0, "", root.join("old.png").to_str().unwrap());
        std::fs::write(root.join("old.png"), [1, 2, 3]).unwrap();

        let moved = root.join("moved-in.md");
        let grouped_dir = root.join("货物素材");
        std::fs::create_dir_all(&grouped_dir).unwrap();
        let grouped = grouped_dir.join("moved.bin");
        std::fs::write(&moved, b"hello").unwrap();
        std::fs::write(&grouped, [9, 8, 7]).unwrap();
        let outside = std::env::temp_dir().join(format!("outside-{}.txt", uuid::Uuid::new_v4()));
        std::fs::write(&outside, b"x").unwrap();

        crate::db::discover_external_resource_files(
            app.handle(),
            &[
                moved.clone(),
                grouped.clone(),
                root.join("old.png"),
                root.join("missing.png"),
                outside.clone(),
            ],
        );

        let ids = |records: &[serde_json::Value]| -> Vec<String> {
            records
                .iter()
                .map(|r| r["id"].as_str().unwrap_or("").to_string())
                .collect()
        };

        let recent = get_clipboard_records_inner(
            &app.handle().clone(),
            None,
            Some(50),
            Some(0),
            Some("resources".to_string()),
            None,
            Some("recent".into()),
        )
        .unwrap();
        let recent_ids = ids(&recent);
        assert_eq!(recent_ids.len(), 3);
        // 两个新移入的文件（发现时间相同，先后不限）都在最前，老资源垫底。
        assert!(recent_ids[0] != "res-old" && recent_ids[1] != "res-old");
        assert_eq!(recent_ids[2], "res-old");
        // 分组子目录里的移入文件按路径归组。
        let top_groups: Vec<String> = recent[..2]
            .iter()
            .map(|r| r["resource_group"].as_str().unwrap_or("").to_string())
            .collect();
        assert!(
            top_groups.contains(&"货物素材".to_string()),
            "分组子目录的移入文件应归入该分组: {top_groups:?}"
        );

        // 最多使用模式：新文件零使用，与新复制的剪切板内容同待遇（未使用区顶部）。
        let count = get_clipboard_records_inner(
            &app.handle().clone(),
            None,
            Some(50),
            Some(0),
            Some("resources".to_string()),
            None,
            Some("count".into()),
        )
        .unwrap();
        assert_eq!(ids(&count).len(), 3);
        assert_eq!(count[2]["id"], "res-old");

        // 重复调用不重复入库。
        crate::db::discover_external_resource_files(app.handle(), &[moved, grouped, outside]);
        let again = get_clipboard_records_inner(
            &app.handle().clone(),
            None,
            Some(50),
            Some(0),
            Some("resources".to_string()),
            None,
            Some("recent".into()),
        )
        .unwrap();
        assert_eq!(again.len(), 3);
        cleanup(&root);
    }

    #[test]
    fn touch_clipboard_usage_increments_use_count_and_touched_ms() {
        // 使用次数与最近使用毫秒时间戳随 touch 自增，供内容列表排序偏好使用。
        let (app, root) = test_app();
        let file = root.join("used-twice.png");
        std::fs::write(&file, [1_u8, 2, 3]).unwrap();
        let id = resource_file_id(&file);

        crate::db::touch_clipboard_usage_internal(app.handle(), &[id.clone()]).unwrap();
        std::thread::sleep(Duration::from_millis(5));
        crate::db::touch_clipboard_usage_internal(app.handle(), &[id.clone()]).unwrap();

        let state = app.state::<DbState>();
        let conn = state.conn.lock().unwrap();
        let (use_count, touched_ms): (i64, i64) = conn
            .query_row(
                "SELECT use_count, touched_ms FROM clipboard_records WHERE id = ?1",
                [&id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(use_count, 2);
        assert!(touched_ms > 0);
        cleanup(&root);
    }

    #[test]
    fn touch_phrase_usage_increments_use_count() {
        let (app, root) = test_app();
        {
            let state = app.state::<DbState>();
            let conn = state.conn.lock().unwrap();
            conn.execute_batch(
                "CREATE TABLE phrase_groups (
                     id TEXT PRIMARY KEY,
                     name TEXT NOT NULL,
                     sort_order INTEGER DEFAULT 0,
                     created_at TEXT NOT NULL,
                     updated_at TEXT NOT NULL
                 );
                 CREATE TABLE phrases (
                     id TEXT PRIMARY KEY,
                     group_id TEXT NOT NULL,
                     title TEXT NOT NULL,
                     content TEXT NOT NULL,
                     input_type TEXT DEFAULT 'text',
                     source_path TEXT DEFAULT '',
                     file_size INTEGER DEFAULT 0,
                     sort_order INTEGER DEFAULT 0,
                     created_at TEXT NOT NULL,
                     updated_at TEXT NOT NULL,
                     last_used_at TEXT DEFAULT '',
                     last_used_ms INTEGER GENERATED ALWAYS AS (CAST((julianday(last_used_at) - 2440587.5) * 86400000 AS INTEGER)) VIRTUAL,
                     use_count INTEGER DEFAULT 0
                 );",
            )
            .unwrap();
            conn.execute(
                "INSERT INTO phrase_groups (id, name, created_at, updated_at)
                 VALUES ('g1', '分组', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z')",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO phrases (id, group_id, title, content, created_at, updated_at)
                 VALUES ('p1', 'g1', '备注', '内容', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z')",
                [],
            )
            .unwrap();
        }
        crate::db::touch_phrase_usage_internal(app.handle(), "p1").unwrap();
        crate::db::touch_phrase_usage_internal(app.handle(), "p1").unwrap();

        let state = app.state::<DbState>();
        let conn = state.conn.lock().unwrap();
        let (use_count, last_used_at): (i64, String) = conn
            .query_row(
                "SELECT use_count, last_used_at FROM phrases WHERE id = 'p1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(use_count, 2);
        assert!(!last_used_at.is_empty());
        cleanup(&root);
    }

    #[test]
    fn sanitizes_trailing_whitespace_only_from_file_record_contents() {
        let (app, _root) = test_app();
        {
            let state = app.state::<DbState>();
            let conn = state.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO clipboard_records (id, type, content, created_at)
                 VALUES ('dirty-file', 'file', '/home/ao/图片/微信图片.jpg\r', '2026-09-11T00:00:00Z')",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO clipboard_records (id, type, content, created_at)
                 VALUES ('plain-text', 'text', '第一行\r\n第二行', '2026-09-11T00:00:01Z')",
                [],
            )
            .unwrap();
        }

        crate::db::sanitize_file_record_contents(app.handle());

        let state = app.state::<DbState>();
        let conn = state.conn.lock().unwrap();
        let file_content: String = conn
            .query_row(
                "SELECT content FROM clipboard_records WHERE id = 'dirty-file'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let text_content: String = conn
            .query_row(
                "SELECT content FROM clipboard_records WHERE id = 'plain-text'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        // 文件记录剥掉行尾回车；文本记录中间的 \r\n 是合法换行，保持原样。
        assert_eq!(file_content, "/home/ao/图片/微信图片.jpg");
        assert_eq!(text_content, "第一行\r\n第二行");
    }

    #[test]
    fn forget_resource_records_removes_subtree_for_deleted_directory() {
        // 外部删除/移出目录时事件只报目录本身：目录下的全部记录（含嵌套
        // 子目录）都要清退，兄弟路径不受影响。
        let (app, root) = test_app();
        let dir = root.join("doomed");
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        let file_a = dir.join("a.mp4");
        let file_b = dir.join("sub").join("b.png");
        let keeper = root.join("kept.png");
        std::fs::write(&file_a, [1]).unwrap();
        std::fs::write(&file_b, [2]).unwrap();
        std::fs::write(&keeper, [3]).unwrap();
        insert_resource(&app, "res-a", 1000.0, "", file_a.to_str().unwrap());
        insert_resource(&app, "res-b", 1000.0, "", file_b.to_str().unwrap());
        insert_resource(&app, "res-kept", 1000.0, "", keeper.to_str().unwrap());

        forget_resource_records(app.handle(), &[dir]);

        let records = get_clipboard_records_inner(
            &app.handle().clone(),
            None,
            Some(50),
            Some(0),
            Some("resources".to_string()),
            None,
            Some("recent".into()),
        )
        .unwrap();
        assert_eq!(records.len(), 1, "目录子树记录应全部清退");
        assert_eq!(records[0]["id"].as_str(), Some("res-kept"));
    }

    #[test]
    fn settle_redirects_renamed_directory_and_keeps_metadata() {
        // 外部把目录改名（事件 = rename 旧路径 + 新路径）：子树记录应整体
        // 重定向到新路径——id/resource_path 改写、api_key_labels 级联、
        // sort_order 等元数据保留，不删了重建。
        let (app, root) = test_app();
        let old_dir = root.join("旧分组");
        std::fs::create_dir_all(old_dir.join("sub")).unwrap();
        let file_x = old_dir.join("x.mp4");
        let file_y = old_dir.join("sub").join("y.mp3");
        std::fs::write(&file_x, [1, 1]).unwrap();
        std::fs::write(&file_y, [2, 2]).unwrap();
        insert_resource(&app, "res-x", 1234.0, "", file_x.to_str().unwrap());
        insert_resource(&app, "res-y", 5678.0, "", file_y.to_str().unwrap());
        {
            let state = app.state::<DbState>();
            let conn = state.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO api_key_labels (record_id, label) VALUES ('res-x', '标签A')",
                [],
            )
            .unwrap();
        }
        let new_dir = root.join("0916");
        std::fs::rename(&old_dir, &new_dir).unwrap();

        settle_external_resource_changes(app.handle(), &[old_dir.clone(), new_dir.clone()]);

        let records = get_clipboard_records_inner(
            &app.handle().clone(),
            None,
            Some(50),
            Some(0),
            Some("resources".to_string()),
            None,
            Some("recent".into()),
        )
        .unwrap();
        assert_eq!(records.len(), 2, "重定向不应丢记录");
        let by_content = |marker: &str| {
            records
                .iter()
                .find(|r| r["content"].as_str() == Some(marker))
                .unwrap_or_else(|| panic!("content={marker} 的记录应保留: {records:?}"))
        };
        let redirected_x = by_content("res-x");
        let redirected_y = by_content("res-y");
        let new_x = new_dir.join("x.mp4");
        let new_y = new_dir.join("sub").join("y.mp3");
        assert_eq!(
            redirected_x["resource_path"].as_str(),
            Some(new_x.to_str().unwrap()),
            "记录应重定向到新路径"
        );
        assert_eq!(
            redirected_y["resource_path"].as_str(),
            Some(new_y.to_str().unwrap())
        );
        // created_at 未被覆盖 = 元数据保留（删了重建会换成发现时刻）。
        assert_eq!(
            redirected_x["created_at"].as_str(),
            Some("2026-08-01T00:00:00Z"),
            "重定向应保留原 created_at"
        );
        assert_eq!(
            redirected_x["id"].as_str(),
            Some(resource_file_id(&new_x).as_str()),
            "id 应随路径级联改写"
        );
        assert!(
            !records.iter().any(|r| r["id"].as_str() == Some("res-x")),
            "旧 id 不应残留"
        );
        assert_eq!(
            redirected_x["resource_group"].as_str(),
            Some("0916"),
            "分组归属应随新路径推导"
        );
        {
            let state = app.state::<DbState>();
            let conn = state.conn.lock().unwrap();
            let label: String = conn
                .query_row(
                    "SELECT label FROM api_key_labels WHERE record_id = ?1",
                    [resource_file_id(&new_x)],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(label, "标签A", "api_key_labels 应级联迁移");
        }
    }

    #[test]
    fn settle_removes_records_when_directory_moved_out_of_library() {
        // 删除到回收站/剪切移出库外 = rename 出监听目录：旧路径事件按
        // stat 裁决为消失，子树记录清退——旧实现按「Modify=到达」处理
        // 会永远漏删（径向菜单/资源页残留已删文件）。
        let (app, root) = test_app();
        let dir = root.join("移出分组");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("a.mp4");
        std::fs::write(&file, [1]).unwrap();
        insert_resource(&app, "res-out", 1000.0, "", file.to_str().unwrap());
        let outside = std::env::temp_dir().join(format!("out-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&outside).unwrap();

        std::fs::rename(&dir, outside.join("移出分组")).unwrap();
        settle_external_resource_changes(app.handle(), &[dir]);

        let records = get_clipboard_records_inner(
            &app.handle().clone(),
            None,
            Some(50),
            Some(0),
            Some("resources".to_string()),
            None,
            Some("recent".into()),
        )
        .unwrap();
        assert_eq!(records.len(), 0, "移出库外的目录记录应被清退");
        std::fs::remove_dir_all(&outside).ok();
    }

    #[test]
    fn settle_discovers_records_when_whole_directory_moved_in() {
        // 外部把整个目录移入库：事件只报目录本身，子文件应递归补建入库
        // 并按路径归组（旧实现只认文件路径，要等重启对账才能发现）。
        let (app, root) = test_app();
        let outside = std::env::temp_dir().join(format!("in-{}", uuid::Uuid::new_v4()));
        let source = outside.join("素材包");
        std::fs::create_dir_all(source.join("nested")).unwrap();
        std::fs::write(source.join("a.mp4"), [1]).unwrap();
        std::fs::write(source.join("nested").join("b.mp3"), [2]).unwrap();

        let target = root.join("素材包");
        std::fs::rename(&source, &target).unwrap();
        settle_external_resource_changes(app.handle(), std::slice::from_ref(&target));

        let records = get_clipboard_records_inner(
            &app.handle().clone(),
            None,
            Some(50),
            Some(0),
            Some("resources".to_string()),
            None,
            Some("recent".into()),
        )
        .unwrap();
        assert_eq!(records.len(), 2, "目录内文件应递归补建");
        let groups: Vec<String> = records
            .iter()
            .map(|r| r["resource_group"].as_str().unwrap_or("").to_string())
            .collect();
        assert!(
            groups.iter().all(|group| group == "素材包"),
            "补建记录应归入新分组: {groups:?}"
        );
        assert!(records.iter().any(|r| r["id"].as_str()
            == Some(resource_file_id(&target.join("a.mp4")).as_str())));
        std::fs::remove_dir_all(&outside).ok();
    }

    #[test]
    fn settle_single_file_trash_rename_swaps_record() {
        // 库内单文件改名：旧路径记录按「文件不在」清退，新路径按发现
        // 时间补建——不产生幽灵重复条目（外部改名等价于删旧建新）。
        let (app, root) = test_app();
        let old_file = root.join("old.mp4");
        std::fs::write(&old_file, [1, 2, 3]).unwrap();
        insert_resource(&app, "res-old-vid", 1000.0, "", old_file.to_str().unwrap());
        let new_file = root.join("new.mp4");
        std::fs::rename(&old_file, &new_file).unwrap();

        settle_external_resource_changes(app.handle(), &[old_file, new_file.clone()]);

        let records = get_clipboard_records_inner(
            &app.handle().clone(),
            None,
            Some(50),
            Some(0),
            Some("resources".to_string()),
            None,
            Some("recent".into()),
        )
        .unwrap();
        assert_eq!(records.len(), 1, "应恰好一条记录（无幽灵无重复）");
        assert_eq!(records[0]["resource_path"].as_str(), Some(new_file.to_str().unwrap()));
        assert_eq!(
            records[0]["id"].as_str(),
            Some(resource_file_id(&new_file).as_str())
        );
    }

    #[test]
    fn storage_mode_backfill_and_resource_index_are_effective() {
        // 回填：异常路径产生的 NULL storage_mode 迁移后归位 'database'，
        // 保证等值查询与旧 COALESCE 语义一致；索引：资源等值查询命中
        // idx_clipboard_storage_mode 而非全表扫描（SCAN）。
        let (app, root) = test_app();
        insert_resource(&app, "res-a", 1000.0, "", root.join("a.mp4").to_str().unwrap());
        {
            let state = app.state::<DbState>();
            let conn = state.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO clipboard_records (id, type, content, created_at, storage_mode)
                 VALUES ('null-mode', 'text', 'x', '2026-08-01T00:00:00Z', NULL)",
                [],
            )
            .unwrap();
            conn.execute_batch(RESOURCE_INDEX_MIGRATION_SQL).unwrap();
            let mode: String = conn
                .query_row(
                    "SELECT storage_mode FROM clipboard_records WHERE id = 'null-mode'",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(mode, "database", "NULL storage_mode 应回填为 'database'");

            let plan: String = conn
                .query_row(
                    "EXPLAIN QUERY PLAN SELECT id, resource_path FROM clipboard_records
                     WHERE storage_mode = 'resource'",
                    [],
                    |row| row.get(3),
                )
                .unwrap();
            assert!(
                plan.contains("idx_clipboard_storage_mode") && !plan.contains("SCAN"),
                "资源等值查询应命中索引而非全表扫描: {plan}"
            );
        }
    }
}

#[cfg(test)]
mod all_phrases_tests {
    use crate::db::{all_phrase_rows, Connection};
    use rusqlite::params;

    fn setup_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "
            CREATE TABLE phrase_groups (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                sort_order INTEGER DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE phrases (
                id TEXT PRIMARY KEY,
                group_id TEXT NOT NULL,
                title TEXT NOT NULL,
                content TEXT NOT NULL,
                input_type TEXT DEFAULT 'text',
                source_path TEXT DEFAULT '',
                file_size INTEGER DEFAULT 0,
                sort_order INTEGER DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                last_used_at TEXT DEFAULT '',
                last_used_ms INTEGER GENERATED ALWAYS AS (CAST((julianday(last_used_at) - 2440587.5) * 86400000 AS INTEGER)) VIRTUAL,
                use_count INTEGER DEFAULT 0,
                FOREIGN KEY (group_id) REFERENCES phrase_groups(id) ON DELETE CASCADE
            );
            ",
        )
        .unwrap();
        conn
    }

    fn insert_group(conn: &Connection, id: &str, sort_order: i64) {
        conn.execute(
            "INSERT INTO phrase_groups (id, name, sort_order, created_at, updated_at)
             VALUES (?1, ?2, ?3, '2026-09-01T00:00:00+00:00', '2026-09-01T00:00:00+00:00')",
            params![id, format!("group-{id}"), sort_order],
        )
        .unwrap();
    }

    fn insert_phrase(
        conn: &Connection,
        id: &str,
        group_id: &str,
        sort_order: i64,
        last_used_at: &str,
    ) {
        conn.execute(
            "INSERT INTO phrases (id, group_id, title, content, sort_order, created_at, updated_at, last_used_at)
             VALUES (?1, ?2, 'title', ?3, ?4, '2026-09-01T00:00:00+00:00', '2026-09-01T00:00:00+00:00', ?5)",
            params![id, group_id, format!("phrase-{id}"), sort_order, last_used_at],
        )
        .unwrap();
    }

    fn set_use_count(conn: &Connection, id: &str, use_count: i64) {
        conn.execute(
            "UPDATE phrases SET use_count = ?1 WHERE id = ?2",
            params![use_count, id],
        )
        .unwrap();
    }

    fn query_ids(conn: &Connection, limit: i64, sort_by: Option<&str>) -> Vec<String> {
        all_phrase_rows(conn, limit, sort_by)
            .unwrap()
            .iter()
            .map(|r| r["id"].as_str().unwrap_or("").to_string())
            .collect()
    }

    #[test]
    fn all_phrase_rows_orders_used_first_then_unused_by_group_and_manual() {
        let conn = setup_conn();
        // g1 分组顺序在前（sort_order 更大）；p3、p1 有使用记录且 p3 更近；
        // 未使用的 p2（g1）、p4（g2）按分组顺序 + 组内手动顺序垫底。
        insert_group(&conn, "g1", 2);
        insert_group(&conn, "g2", 1);
        insert_phrase(&conn, "p1", "g1", 2, "2026-09-04T10:00:00+00:00");
        insert_phrase(&conn, "p2", "g1", 1, "");
        insert_phrase(&conn, "p3", "g2", 1, "2026-09-05T10:00:00+00:00");
        insert_phrase(&conn, "p4", "g2", 2, "");

        assert_eq!(query_ids(&conn, i64::MAX, None), vec!["p3", "p1", "p2", "p4"]);
    }

    #[test]
    fn all_phrase_rows_reflects_touch_after_the_fact() {
        // 模拟 touch：UPDATE 后重查，刚使用的短语应排到最前。
        let conn = setup_conn();
        insert_group(&conn, "g1", 1);
        insert_phrase(&conn, "a", "g1", 2, "2026-09-03T10:00:00+00:00");
        insert_phrase(&conn, "b", "g1", 1, "2026-09-04T10:00:00+00:00");
        conn.execute(
            "UPDATE phrases SET last_used_at = ?1 WHERE id = 'a'",
            params!["2026-09-06T10:00:00+00:00"],
        )
        .unwrap();

        assert_eq!(query_ids(&conn, i64::MAX, None), vec!["a", "b"]);
    }

    #[test]
    fn all_phrase_rows_count_mode_orders_by_use_count_then_recent() {
        let conn = setup_conn();
        // 次数倒序；并列次数按最近使用优先；零次数按分组 + 手动顺序垫底。
        insert_group(&conn, "g1", 2);
        insert_group(&conn, "g2", 1);
        insert_phrase(&conn, "hot", "g1", 2, "2026-09-03T10:00:00+00:00");
        insert_phrase(&conn, "warm", "g2", 1, "2026-09-05T10:00:00+00:00");
        insert_phrase(&conn, "cold", "g1", 1, "2026-09-04T10:00:00+00:00");
        insert_phrase(&conn, "unused-1", "g2", 2, "");
        insert_phrase(&conn, "unused-2", "g1", 3, "");
        set_use_count(&conn, "hot", 30);
        set_use_count(&conn, "warm", 30);
        set_use_count(&conn, "cold", 1);

        assert_eq!(
            query_ids(&conn, i64::MAX, Some("count")),
            vec!["warm", "hot", "cold", "unused-2", "unused-1"]
        );
    }

    #[test]
    fn all_phrase_rows_applies_limit_and_joins_group_name() {
        let conn = setup_conn();
        insert_group(&conn, "g1", 1);
        insert_phrase(&conn, "p1", "g1", 2, "2026-09-05T10:00:00+00:00");
        insert_phrase(&conn, "p2", "g1", 1, "2026-09-04T10:00:00+00:00");

        assert_eq!(query_ids(&conn, 1, None), vec!["p1"]);

        let rows = all_phrase_rows(&conn, i64::MAX, None).unwrap();
        assert_eq!(rows[0]["group_name"], "group-g1");
        assert_eq!(rows[0]["last_used_at"], "2026-09-05T10:00:00+00:00");
        assert_eq!(rows[0]["use_count"], 0);
    }

    #[test]
    fn all_phrase_rows_sorts_by_real_time_not_string_order() {
        // 排序语义锁定为「按真实时间（毫秒）」而非文本字典序：当前写入的
        // RFC3339 带 '+00:00' 后缀时两者恰好一致，但格式一旦漂移（如换 'Z'
        // 后缀，'Z' > '.' 会使整秒误判为更新）字符串比较即出错，毫秒生成
        // 列对格式免疫。
        let conn = setup_conn();
        insert_group(&conn, "g1", 1);
        insert_phrase(&conn, "whole", "g1", 2, "2026-09-05T10:00:00+00:00");
        insert_phrase(&conn, "later", "g1", 1, "2026-09-05T10:00:00.100+00:00");
        insert_phrase(&conn, "newest", "g1", 3, "2026-09-05T10:00:00.999+00:00");

        assert_eq!(query_ids(&conn, i64::MAX, None), vec!["newest", "later", "whole"]);
    }
}

#[cfg(test)]
mod content_sort_tests {
    use crate::db::{clipboard_order_clause, Connection};
    use rusqlite::params;

    fn setup_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE clipboard_records (
                id TEXT PRIMARY KEY,
                sort_order REAL,
                touched_ms INTEGER DEFAULT 0,
                use_count INTEGER DEFAULT 0,
                pinned INTEGER NOT NULL DEFAULT 0
            );",
        )
        .unwrap();
        conn
    }

    fn insert(conn: &Connection, id: &str, sort_order: f64, touched_ms: i64, use_count: i64) {
        insert_pinned(conn, id, sort_order, touched_ms, use_count, 0);
    }

    fn insert_pinned(
        conn: &Connection,
        id: &str,
        sort_order: f64,
        touched_ms: i64,
        use_count: i64,
        pinned: i64,
    ) {
        conn.execute(
            "INSERT INTO clipboard_records (id, sort_order, touched_ms, use_count, pinned)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![id, sort_order, touched_ms, use_count, pinned],
        )
        .unwrap();
    }

    fn ordered_ids(conn: &Connection, sort_by: Option<&str>) -> Vec<String> {
        let sql = format!(
            "SELECT id FROM clipboard_records ORDER BY {}",
            clipboard_order_clause(sort_by)
        );
        let mut stmt = conn.prepare(&sql).unwrap();
        let rows = stmt.query_map([], |row| row.get::<_, String>(0)).unwrap();
        rows.map(|r| r.unwrap()).collect()
    }

    #[test]
    fn created_clause_keeps_current_sort_order_semantics() {
        let conn = setup_conn();
        insert(&conn, "old", 1000.0, 0, 5);
        insert(&conn, "new", 2000.0, 0, 0);
        assert_eq!(ordered_ids(&conn, None), vec!["new", "old"]);
    }

    #[test]
    fn recent_clause_floats_touched_above_sort_order_and_keeps_fresh_copies_on_top() {
        let conn = setup_conn();
        // 刚复制（sort_order 最新、未使用）置顶；刚使用的旧记录上浮；
        // 其余未使用条目按复制时间排。
        insert(&conn, "fresh-copy", 3000.0, 0, 0);
        insert(&conn, "just-used", 1000.0, 2500, 1);
        insert(&conn, "old-copy", 2000.0, 0, 0);
        assert_eq!(
            ordered_ids(&conn, Some("recent")),
            vec!["fresh-copy", "just-used", "old-copy"]
        );
    }

    #[test]
    fn count_clause_orders_by_use_count_then_recent_with_zero_partition() {
        let conn = setup_conn();
        // 次数倒序；并列次数最近者优先；零次数按时间序垫底。
        insert(&conn, "hot", 1000.0, 0, 30);
        insert(&conn, "warm", 2000.0, 0, 30);
        insert(&conn, "cold", 3000.0, 0, 1);
        insert(&conn, "fresh", 4000.0, 0, 0);
        insert(&conn, "stale", 500.0, 0, 0);
        assert_eq!(
            ordered_ids(&conn, Some("count")),
            vec!["warm", "hot", "cold", "fresh", "stale"]
        );
    }

    // 收藏恒定浮顶：pinned DESC 前置于三类排序键，任何排序模式下收藏记录
    // 都在非收藏之前；收藏之间保持该模式原有次序。
    #[test]
    fn pinned_rows_float_above_others_in_every_sort_mode() {
        let conn = setup_conn();
        // pinned 记录复制时间与使用次数都更旧，仍须排最前。
        insert_pinned(&conn, "fav-old", 100.0, 0, 0, 1);
        insert(&conn, "new", 9000.0, 0, 0);
        insert(&conn, "hot", 200.0, 0, 30);
        assert_eq!(ordered_ids(&conn, None), vec!["fav-old", "new", "hot"]);
        assert_eq!(ordered_ids(&conn, Some("recent")), vec!["fav-old", "new", "hot"]);
        assert_eq!(ordered_ids(&conn, Some("count")), vec!["fav-old", "hot", "new"]);
    }
}

#[cfg(test)]
mod pinned_record_tests {
    use crate::db::{
        get_clipboard_records_inner, prune_old_records, set_clipboard_record_pinned_internal,
        DbState,
    };
    use rusqlite::{params, Connection};
    use std::sync::Mutex;
    use tauri::Manager;

    /// 内存库 + mock app：schema 含 created_ms 生成列（prune 的清理键）与
    /// pinned（收藏标记），与生产 ensure_schema 语义一致。
    fn pinned_test_app() -> tauri::App<tauri::test::MockRuntime> {
        let app = tauri::test::mock_app();
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             CREATE TABLE clipboard_records (
                 id TEXT PRIMARY KEY,
                 type TEXT NOT NULL,
                 content TEXT NOT NULL,
                 source_app TEXT DEFAULT '',
                 created_at TEXT NOT NULL,
                 user_api_key INTEGER DEFAULT 0,
                 sort_order REAL,
                 group_name TEXT DEFAULT '',
                 attachments TEXT DEFAULT '[]',
                 storage_mode TEXT DEFAULT 'database',
                 resource_path TEXT DEFAULT '',
                 resource_note TEXT DEFAULT '',
                 resource_external INTEGER DEFAULT 0,
                 last_used_at TEXT DEFAULT '',
                 use_count INTEGER DEFAULT 0,
                 touched_ms INTEGER DEFAULT 0,
                 pinned INTEGER NOT NULL DEFAULT 0,
                 created_ms INTEGER GENERATED ALWAYS AS (CAST((julianday(created_at) - 2440587.5) * 86400000 AS INTEGER)) VIRTUAL
             );
             CREATE TABLE api_key_labels (
                 record_id TEXT PRIMARY KEY,
                 label TEXT DEFAULT ''
             );",
        )
        .unwrap();
        app.manage(DbState {
            conn: Mutex::new(conn),
        });
        app
    }

    fn insert_record(app: &tauri::App<tauri::test::MockRuntime>, id: &str, created_at: &str) {
        let state = app.state::<DbState>();
        let conn = state.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO clipboard_records (id, type, content, created_at, sort_order)
             VALUES (?1, 'text', ?2, ?3, 1000.0)",
            params![id, id, created_at],
        )
        .unwrap();
    }

    fn remaining_ids(app: &tauri::App<tauri::test::MockRuntime>) -> Vec<String> {
        let state = app.state::<DbState>();
        let conn = state.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT id FROM clipboard_records ORDER BY id")
            .unwrap();
        stmt.query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap()
    }

    // 收藏记录是用户明确要留的内容：超期后清理只淘汰未收藏记录，
    // 收藏记录与其引用的图片文件不随保留期消失。
    #[test]
    fn prune_keeps_pinned_records_but_expires_others() {
        let app = pinned_test_app();
        let handle = app.handle().clone();
        // 两条超期（1 年前）：一条收藏、一条普通；一条新鲜普通记录作对照。
        insert_record(&app, "old-pinned", "2025-09-01T00:00:00Z");
        insert_record(&app, "old-plain", "2025-09-01T00:00:00Z");
        insert_record(&app, "fresh-plain", "2026-09-18T00:00:00Z");
        set_clipboard_record_pinned_internal(&handle, &["old-pinned".to_string()], true).unwrap();

        prune_old_records(&handle).unwrap();

        assert_eq!(remaining_ids(&app), vec!["fresh-plain", "old-pinned"]);
    }

    // 取消收藏后恢复受清理管辖：收藏是可逆的保护，不是删除。
    #[test]
    fn unpinning_restores_retention_semantics() {
        let app = pinned_test_app();
        let handle = app.handle().clone();
        insert_record(&app, "maybe", "2025-09-01T00:00:00Z");
        set_clipboard_record_pinned_internal(&handle, &["maybe".to_string()], true).unwrap();
        set_clipboard_record_pinned_internal(&handle, &["maybe".to_string()], false).unwrap();

        prune_old_records(&handle).unwrap();

        assert!(remaining_ids(&app).is_empty());
    }

    // 列表查询带回 pinned 事实字段且收藏浮顶（与排序子句测试互补，钉住
    // SELECT 列与 JSON 组装的端到端一致性）。
    #[test]
    fn list_carries_pinned_flag_and_floats_favorites_first() {
        let app = pinned_test_app();
        let handle = app.handle().clone();
        insert_record(&app, "fav", "2025-09-01T00:00:00Z");
        insert_record(&app, "plain", "2026-09-18T00:00:00Z");
        set_clipboard_record_pinned_internal(&handle, &["fav".to_string()], true).unwrap();

        let records =
            get_clipboard_records_inner(&handle, None, Some(50), Some(0), None, None, None)
                .unwrap();

        let ids: Vec<&str> = records
            .iter()
            .map(|r| r["id"].as_str().unwrap())
            .collect();
        assert_eq!(ids, vec!["fav", "plain"]);
        assert_eq!(records[0]["pinned"], serde_json::Value::Bool(true));
        assert_eq!(records[1]["pinned"], serde_json::Value::Bool(false));
    }

    // 「收藏」视图（category=favorites）：数据库层过滤，跨类别只返回收藏
    // 记录；搜索分支同样生效。
    #[test]
    fn favorites_category_filters_at_database_layer() {
        let app = pinned_test_app();
        let handle = app.handle().clone();
        insert_record(&app, "fav-text", "2025-09-01T00:00:00Z");
        insert_record(&app, "plain", "2026-09-18T00:00:00Z");
        set_clipboard_record_pinned_internal(&handle, &["fav-text".to_string()], true).unwrap();

        let ids_of = |records: &[serde_json::Value]| -> Vec<String> {
            records
                .iter()
                .map(|r| r["id"].as_str().unwrap().to_string())
                .collect()
        };
        let favorites = get_clipboard_records_inner(
            &handle,
            None,
            Some(50),
            Some(0),
            Some("favorites".to_string()),
            None,
            None,
        )
        .unwrap();
        assert_eq!(ids_of(&favorites), vec!["fav-text"]);

        let searched = get_clipboard_records_inner(
            &handle,
            Some("fav-text".to_string()),
            Some(50),
            Some(0),
            Some("favorites".to_string()),
            None,
            None,
        )
        .unwrap();
        assert_eq!(ids_of(&searched), vec!["fav-text"]);

        let searched_out = get_clipboard_records_inner(
            &handle,
            Some("plain".to_string()),
            Some(50),
            Some(0),
            Some("favorites".to_string()),
            None,
            None,
        )
        .unwrap();
        assert!(ids_of(&searched_out).is_empty());
    }
}

#[cfg(test)]
mod trash_tests {
    use crate::db::{
        delete_clipboard_records_internal, ensure_schema, list_trash_items_internal,
        prune_old_records, purge_trash_internal, restore_trash_item_internal, DbState,
    };
    use rusqlite::params;
    use std::path::{Path, PathBuf};
    use std::sync::Mutex;
    use tauri::Manager;

    fn trash_test_app() -> (tauri::App<tauri::test::MockRuntime>, PathBuf) {
        let app = tauri::test::mock_app();
        let library = std::env::temp_dir().join(format!(
            "copy-creator-trash-test-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&library).unwrap();
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        ensure_schema(&conn).unwrap();
        conn.execute(
            "INSERT INTO settings (key, value) VALUES ('resource_library_path', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![library.to_string_lossy().as_ref()],
        )
        .unwrap();
        app.manage(DbState {
            conn: Mutex::new(conn),
        });
        (app, library)
    }

    fn insert_external_record(
        app: &tauri::App<tauri::test::MockRuntime>,
        id: &str,
        path: &Path,
        attachments: &[String],
    ) {
        let state = app.state::<DbState>();
        let conn = state.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO clipboard_records
             (id, type, content, created_at, group_name, storage_mode, resource_path, resource_external, attachments)
             VALUES (?1, 'file', ?2, '2026-09-18T00:00:00Z', '', 'resource', ?2, 1, ?3)",
            params![
                id,
                path.to_string_lossy().as_ref(),
                serde_json::to_string(attachments).unwrap()
            ],
        )
        .unwrap();
    }

    fn record_count(app: &tauri::App<tauri::test::MockRuntime>, id: &str) -> i64 {
        let state = app.state::<DbState>();
        let conn = state.conn.lock().unwrap();
        conn.query_row(
            "SELECT COUNT(*) FROM clipboard_records WHERE id = ?1",
            params![id],
            |row| row.get(0),
        )
        .unwrap()
    }

    // 应用内删除资源记录：文件移入库根 .trash（原位消失）、trash_items
    // 落一行、clipboard_records 无行；恢复后文件回原位、记录整行回插
    // （分组/备注经 resource_path 与元数据保留）。
    #[test]
    fn deleting_resource_record_trashes_file_and_restore_brings_it_back() {
        let (app, library) = trash_test_app();
        let handle = app.handle().clone();
        let group_dir = library.join("项目资料");
        std::fs::create_dir_all(&group_dir).unwrap();
        let file = group_dir.join("报价.pdf");
        std::fs::write(&file, b"pdf").unwrap();
        insert_external_record(&app, "r1", &file, &[]);

        delete_clipboard_records_internal(&handle, &["r1".to_string()]).unwrap();

        assert_eq!(record_count(&app, "r1"), 0);
        assert!(!file.exists());
        let items = list_trash_items_internal(&handle).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["file_name"], serde_json::json!("报价.pdf"));
        assert_eq!(items[0]["original_group"], serde_json::json!("项目资料"));
        let trash_id = items[0]["id"].as_str().unwrap().to_string();

        restore_trash_item_internal(&handle, &trash_id).unwrap();

        assert!(file.exists());
        assert_eq!(std::fs::read(&file).unwrap(), b"pdf");
        assert_eq!(record_count(&app, "r1"), 1);
        assert!(list_trash_items_internal(&handle).unwrap().is_empty());
    }

    // 恢复同名冲突：原位已被同名文件占用时恢复为 "name (1).ext"，并同步
    // 记录的 content / resource_path 指向新落位文件。
    #[test]
    fn restore_resolves_name_conflicts_with_numbered_suffix() {
        let (app, library) = trash_test_app();
        let handle = app.handle().clone();
        let group_dir = library.join("组");
        std::fs::create_dir_all(&group_dir).unwrap();
        let file = group_dir.join("doc.txt");
        std::fs::write(&file, b"old").unwrap();
        insert_external_record(&app, "r1", &file, &[]);

        delete_clipboard_records_internal(&handle, &["r1".to_string()]).unwrap();
        std::fs::write(&file, b"occupied").unwrap();

        let trash_id = list_trash_items_internal(&handle).unwrap()[0]["id"]
            .as_str()
            .unwrap()
            .to_string();
        restore_trash_item_internal(&handle, &trash_id).unwrap();

        let restored = group_dir.join("doc (1).txt");
        assert!(restored.exists());
        assert_eq!(std::fs::read(&restored).unwrap(), b"old");
        let state = app.state::<DbState>();
        let conn = state.conn.lock().unwrap();
        let stored_path: String = conn
            .query_row(
                "SELECT resource_path FROM clipboard_records WHERE id = 'r1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(Path::new(&stored_path), restored.as_path());
    }

    // 彻底删除：回收目录与记录行清除，record_json 里的附件一并清理。
    #[test]
    fn purging_removes_trash_dir_and_orphan_attachments() {
        let (app, library) = trash_test_app();
        let handle = app.handle().clone();
        let group_dir = library.join("组");
        std::fs::create_dir_all(&group_dir).unwrap();
        // 附件固定在库根 .copy-creator/attachments（与写入侧一致）。
        let attachment_dir = library.join(".copy-creator").join("attachments").join("r1-abc");
        std::fs::create_dir_all(&attachment_dir).unwrap();
        let attachment = attachment_dir.join("image-1.png");
        std::fs::write(&attachment, b"png").unwrap();
        let file = group_dir.join("笔记.md");
        std::fs::write(&file, b"md").unwrap();
        insert_external_record(&app, "r1", &file, &[attachment.to_string_lossy().to_string()]);

        delete_clipboard_records_internal(&handle, &["r1".to_string()]).unwrap();
        let trash_id = list_trash_items_internal(&handle).unwrap()[0]["id"]
            .as_str()
            .unwrap()
            .to_string();

        purge_trash_internal(&handle, Some(&[trash_id])).unwrap();

        assert!(!file.exists());
        assert!(!attachment.exists());
        assert!(list_trash_items_internal(&handle).unwrap().is_empty());
        assert_eq!(record_count(&app, "r1"), 0);
    }

    // 过期清理：trashed_ms 超过保留期（默认 30 天）的条目随保留期任务
    // 清除（prune_old_records 即回收站的清理执行点）。
    #[test]
    fn prune_purges_expired_trash_items() {
        let (app, library) = trash_test_app();
        let handle = app.handle().clone();
        let group_dir = library.join("组");
        std::fs::create_dir_all(&group_dir).unwrap();
        let file = group_dir.join("旧文件.txt");
        std::fs::write(&file, b"old").unwrap();
        insert_external_record(&app, "r1", &file, &[]);
        delete_clipboard_records_internal(&handle, &["r1".to_string()]).unwrap();
        assert_eq!(list_trash_items_internal(&handle).unwrap().len(), 1);

        {
            let state = app.state::<DbState>();
            let conn = state.conn.lock().unwrap();
            conn.execute("UPDATE trash_items SET trashed_ms = 1000", [])
                .unwrap();
        }

        prune_old_records(&handle).unwrap();

        assert!(list_trash_items_internal(&handle).unwrap().is_empty());
        assert!(!file.exists());
    }
}

#[cfg(test)]
mod migrate_storage_tests {
    use crate::db::{ensure_schema, migrate_storage_data, Connection};

    fn seed_old_library(old_dir: &std::path::Path) -> std::path::PathBuf {
        std::fs::create_dir_all(old_dir).unwrap();
        let old_db = old_dir.join("data.db");
        let conn = Connection::open(&old_db).unwrap();
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;")
            .unwrap();
        ensure_schema(&conn).unwrap();
        conn.execute(
            "INSERT INTO clipboard_records (id, type, content, created_at, resource_note, use_count)
             VALUES ('r1', 'text', 'hello', '2026-01-01T00:00:00Z', '备注', 3)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO phrase_groups (id, name, sort_order, created_at, updated_at)
             VALUES ('g1', '分组', 0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO phrases (id, group_id, title, content, created_at, updated_at)
             VALUES ('p1', 'g1', '标题', '内容', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
            [],
        )
        .unwrap();
        drop(conn);
        std::fs::create_dir_all(old_dir.join("images")).unwrap();
        std::fs::write(old_dir.join("images").join("a.png"), b"png-bytes").unwrap();
        old_db
    }

    /// 完整迁移：业务数据逐表复制（含 ensure_schema 增量列）+ 附件目录
    /// 搬迁。回归锚点：迁移实现曾只复制 settings，业务数据被静默丢弃。
    #[test]
    fn migrates_business_data_and_assets_to_new_location() {
        let base = std::env::temp_dir().join(format!(
            "copy-creator-migrate-{}",
            uuid::Uuid::new_v4()
        ));
        let old_dir = base.join("old");
        let new_dir = base.join("new");
        std::fs::create_dir_all(&new_dir).unwrap();
        let old_db = seed_old_library(&old_dir);

        let new_conn = migrate_storage_data(&old_db, &old_dir, &new_dir).unwrap();

        let (note, use_count): (String, i64) = new_conn
            .query_row(
                "SELECT resource_note, use_count FROM clipboard_records WHERE id = 'r1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(note, "备注");
        assert_eq!(use_count, 3);
        let phrase_count: i64 = new_conn
            .query_row("SELECT COUNT(*) FROM phrases", [], |row| row.get(0))
            .unwrap();
        assert_eq!(phrase_count, 1);
        assert_eq!(
            std::fs::read(new_dir.join("images").join("a.png")).unwrap(),
            b"png-bytes".to_vec()
        );
        // 旧库保留作备份，不受迁移影响。
        assert!(old_db.exists());

        let _ = std::fs::remove_dir_all(base);
    }

    /// 重试幂等：上次迁移残留的半成品新库会被清除，重试迁移到同一目录
    /// 得到完整的最新数据，而不是叠加或报 UNIQUE 冲突。
    #[test]
    fn retried_migration_replaces_stale_partial_target() {
        let base = std::env::temp_dir().join(format!(
            "copy-creator-migrate-retry-{}",
            uuid::Uuid::new_v4()
        ));
        let old_dir = base.join("old");
        let new_dir = base.join("new");
        std::fs::create_dir_all(&new_dir).unwrap();
        let old_db = seed_old_library(&old_dir);

        let first = migrate_storage_data(&old_db, &old_dir, &new_dir).unwrap();
        drop(first);

        // 第一次迁移后旧库又新增一条记录，然后向同一目标目录重试。
        {
            let conn = Connection::open(&old_db).unwrap();
            conn.execute(
                "INSERT INTO clipboard_records (id, type, content, created_at)
                 VALUES ('r2', 'text', 'second', '2026-01-02T00:00:00Z')",
                [],
            )
            .unwrap();
        }

        let second = migrate_storage_data(&old_db, &old_dir, &new_dir).unwrap();
        let count: i64 = second
            .query_row("SELECT COUNT(*) FROM clipboard_records", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 2);

        let _ = std::fs::remove_dir_all(base);
    }
}

#[cfg(test)]
mod created_ms_tests {
    use crate::db::{ensure_schema, Connection, params};

    fn setup() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        ensure_schema(&conn).unwrap();
        conn
    }

    /// created_ms 是 created_at 的生成列：插入路径无需显式写值即自动可得。
    #[test]
    fn created_ms_is_derived_from_created_at() {
        let conn = setup();
        conn.execute(
            "INSERT INTO clipboard_records (id, type, content, created_at)
             VALUES ('r1', 'text', 'hello', '2020-01-01T00:00:00Z')",
            [],
        )
        .unwrap();
        let created_ms: i64 = conn
            .query_row(
                "SELECT created_ms FROM clipboard_records WHERE id = 'r1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(created_ms, 1_577_836_800_000);
    }

    /// 清理查询语义：created_ms 毫秒比较命中过期行并由 RETURNING 拿回；
    /// 资源记录豁免、未过期记录保留。
    #[test]
    fn prune_deletes_only_expired_rows_and_returns_them() {
        let conn = setup();
        conn.execute(
            "INSERT INTO clipboard_records (id, type, content, created_at)
             VALUES ('old', 'text', 'old-content', '2020-01-01T00:00:00Z')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO clipboard_records (id, type, content, created_at, storage_mode)
             VALUES ('res', 'file', '/lib/x.png', '2020-01-01T00:00:00Z', 'resource')",
            [],
        )
        .unwrap();
        // fresh 用明确的未来时间：与下方阈值取"当前时刻"之间若跨毫秒，
        // 恰好等于阈值会比较出脆弱边界（测试自身的竞态，与实现无关）。
        conn.execute(
            "INSERT INTO clipboard_records (id, type, content, created_at)
             VALUES ('fresh', 'text', 'fresh-content', ?1)",
            params![(chrono::Utc::now() + chrono::Duration::hours(1)).to_rfc3339()],
        )
        .unwrap();

        let now_ms = chrono::Utc::now().timestamp_millis();
        let mut stmt = conn
            .prepare(
                "DELETE FROM clipboard_records
                 WHERE created_ms < ?1
                   AND NOT (storage_mode = 'resource')
                 RETURNING id",
            )
            .unwrap();
        let mut deleted: Vec<String> = stmt
            .query_map(params![now_ms], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        drop(stmt);
        deleted.sort();
        assert_eq!(deleted, vec!["old"]);

        let mut remaining: Vec<String> = conn
            .prepare("SELECT id FROM clipboard_records ORDER BY id")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        remaining.sort();
        assert_eq!(remaining, vec!["fresh", "res"]);
    }
}

#[cfg(test)]
mod group_scan_tests {
    use crate::db::{scan_resource_files, scan_resource_files_under};

    /// 子树扫描：只返回目标分组目录下的文件，分组仍相对库根计算；
    /// 全库扫描结果包含它（子树限定的语义补集校验）。
    #[test]
    fn scan_resource_files_under_limits_to_target_subtree() {
        let root = std::env::temp_dir().join(format!(
            "copy-creator-scan-under-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(root.join("Group/nested")).unwrap();
        std::fs::create_dir_all(root.join("Other")).unwrap();
        std::fs::write(root.join("Group/a.txt"), "a").unwrap();
        std::fs::write(root.join("Group/nested/b.txt"), "b").unwrap();
        std::fs::write(root.join("Other/c.txt"), "c").unwrap();
        std::fs::write(root.join("top.txt"), "t").unwrap();

        let under = scan_resource_files_under(&root, &root.join("Group"));
        // 断言以 `/` 分隔符书写；Windows 实际路径为 `\`，归一后比较。
        let mut under_paths = under
            .iter()
            .map(|entry| {
                entry
                    .path
                    .strip_prefix(&root)
                    .unwrap()
                    .to_string_lossy()
                    .to_string()
                    .replace(['\\'], "/")
            })
            .collect::<Vec<_>>();
        under_paths.sort();
        assert_eq!(under_paths, vec!["Group/a.txt", "Group/nested/b.txt"]);
        assert!(under
            .iter()
            .all(|entry| entry.group == "Group" || entry.group == "Group/nested"));

        let all = scan_resource_files(&root);
        assert!(all.len() >= under.len());

        let _ = std::fs::remove_dir_all(root);
    }
}

#[cfg(test)]
// 用例断言 Windows 路径语义（盘符、反斜杠、大小写不敏感），仅 Windows 有意义。
#[cfg(windows)]
mod managed_path_tests {
    use crate::db::path_within_any;
    use std::path::{Path, PathBuf};

    fn roots() -> Vec<PathBuf> {
        vec![
            PathBuf::from(r"C:\Users\u\AppData\Roaming\com.copycreator.app"),
            PathBuf::from(r"D:\lib"),
        ]
    }

    /// 存储目录内（含子目录）放行；目录外绝对路径与目录外前缀一律拒绝。
    #[test]
    fn allows_only_paths_under_managed_roots() {
        assert!(path_within_any(
            Path::new(r"C:\Users\u\AppData\Roaming\com.copycreator.app\images\a.png"),
            &roots()
        ));
        assert!(path_within_any(Path::new(r"D:\lib\Group\b.txt"), &roots()));
        assert!(!path_within_any(Path::new(r"C:\Windows\system32\cmd.exe"), &roots()));
        // 前缀相似但目录名不同（"library" vs "lib"）不得放行。
        assert!(!path_within_any(Path::new(r"D:\library\x.png"), &roots()));
    }

    /// 大小写不敏感（Windows 语义）；空路径拒绝。
    #[test]
    fn comparison_is_case_insensitive_and_rejects_empty() {
        assert!(path_within_any(
            Path::new(r"c:\users\U\appdata\roaming\COM.COPYCREATOR.APP\images\a.png"),
            &roots()
        ));
        assert!(!path_within_any(Path::new(""), &roots()));
    }
}

#[cfg(test)]
mod recorded_file_path_tests {
    use crate::db::{is_recorded_file_path, DbState};
    use std::sync::Mutex;
    use tauri::Manager;

    /// 内存库 + mock app：clipboard_records / phrases 与生产 schema 同列
    /// （is_recorded_file_path 只依赖 content / resource_path / attachments
    /// 与 phrases.source_path）。
    fn app_with_records(rows: &[(&str, &str, &str)]) -> tauri::App<tauri::test::MockRuntime> {
        let app = tauri::test::mock_app();
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE clipboard_records (
                 id TEXT PRIMARY KEY,
                 type TEXT NOT NULL,
                 content TEXT NOT NULL,
                 source_app TEXT DEFAULT '',
                 created_at TEXT NOT NULL,
                 user_api_key INTEGER DEFAULT 0,
                 sort_order REAL,
                 group_name TEXT DEFAULT '',
                 attachments TEXT DEFAULT '[]',
                 storage_mode TEXT DEFAULT 'database',
                 resource_path TEXT DEFAULT '',
                 resource_note TEXT DEFAULT '',
                 resource_external INTEGER DEFAULT 0,
                 last_used_at TEXT DEFAULT '',
                 use_count INTEGER DEFAULT 0,
                 touched_ms INTEGER DEFAULT 0
             );
             CREATE TABLE phrases (
                 id TEXT PRIMARY KEY,
                 group_id TEXT NOT NULL DEFAULT '',
                 title TEXT NOT NULL DEFAULT '',
                 content TEXT NOT NULL DEFAULT '',
                 input_type TEXT DEFAULT 'text',
                 source_path TEXT DEFAULT '',
                 file_size INTEGER DEFAULT 0,
                 sort_order REAL,
                 created_at TEXT NOT NULL,
                 updated_at TEXT NOT NULL,
                 last_used_at TEXT DEFAULT '',
                 use_count INTEGER DEFAULT 0,
                 touched_ms INTEGER DEFAULT 0
             );",
        )
        .unwrap();
        for (id, content, resource_path) in rows {
            conn.execute(
                "INSERT INTO clipboard_records (id, type, content, created_at, resource_path)
                 VALUES (?1, 'file', ?2, '2026-09-15T00:00:00Z', ?3)",
                rusqlite::params![id, content, resource_path],
            )
            .unwrap();
        }
        app.manage(DbState {
            conn: Mutex::new(conn),
        });
        app
    }

    /// 记录在案的三种形态：content、resource_path、attachments 元素。
    #[test]
    fn allows_paths_recorded_in_content_resource_path_or_attachments() {
        let app = app_with_records(&[(
            "rec-1",
            r"D:\downloads\奥克斯设计图.png",
            r"D:\lib\产品道具\四肢冒着蓝光.png",
        )]);
        {
            let state = app.state::<DbState>();
            let conn = state.conn.lock().unwrap();
            conn.execute(
                "UPDATE clipboard_records SET attachments = ?1 WHERE id = 'rec-1'",
                [r#"["E:\\photos\\附件图.jpg"]"#],
            )
            .unwrap();
        }

        assert!(is_recorded_file_path(
            app.handle(),
            r"D:\downloads\奥克斯设计图.png"
        ));
        assert!(is_recorded_file_path(
            app.handle(),
            r"D:\lib\产品道具\四肢冒着蓝光.png"
        ));
        assert!(is_recorded_file_path(app.handle(), r"E:\photos\附件图.jpg"));
    }

    /// 安全面钉死：只有全等命中才放行。子串、目录前缀、相似路径都不算
    /// "记录在案"——若实现退化为子串匹配，注入者可用极短路径命中记录。
    #[test]
    fn rejects_substring_directory_and_unrelated_paths() {
        let app = app_with_records(&[(
            "rec-1",
            r"D:\downloads\奥克斯设计图.png",
            r"D:\lib\产品道具\四肢冒着蓝光.png",
        )]);

        assert!(!is_recorded_file_path(app.handle(), r"D:\downloads"));
        assert!(!is_recorded_file_path(app.handle(), r"D:\downloads\"));
        assert!(!is_recorded_file_path(
            app.handle(),
            r"D:\lib\产品道具\四肢冒着蓝光.png.bak"
        ));
        assert!(!is_recorded_file_path(
            app.handle(),
            r"C:\Windows\system32\cmd.exe"
        ));
        assert!(!is_recorded_file_path(app.handle(), ""));
    }

    /// 英文字母大小写不敏感（Windows 路径语义）；非 ASCII 部分仍须逐字相等。
    #[test]
    fn matches_case_insensitively_for_ascii_letters() {
        let app = app_with_records(&[("rec-1", r"D:\Downloads\Design.PNG", "")]);

        assert!(is_recorded_file_path(app.handle(), r"d:\downloads\design.png"));
        assert!(!is_recorded_file_path(
            app.handle(),
            r"d:\downloads\design.pngx"
        ));
    }

    /// 文件快捷输入的源路径（phrases.source_path，用户挑选文件时的原始
    /// 位置）也算记录在案：编辑对话框预览的就是这个路径。
    #[test]
    fn allows_phrase_source_paths() {
        let app = app_with_records(&[]);
        {
            let state = app.state::<DbState>();
            let conn = state.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO phrases (id, group_id, title, content, input_type, source_path, created_at, updated_at)
                 VALUES ('p1', 'g', '短语', 'quick-input-files/p1.png', 'file', ?1, '2026-09-15T00:00:00Z', '2026-09-15T00:00:00Z')",
                [r"D:\downloads\即梦生成图.png"],
            )
            .unwrap();
        }

        assert!(is_recorded_file_path(
            app.handle(),
            r"D:\downloads\即梦生成图.png"
        ));
        // phrases 表存在时未记录路径仍须拒绝（不因表存在而误放行）。
        assert!(!is_recorded_file_path(
            app.handle(),
            r"D:\downloads\未挑选的文件.png"
        ));
    }

    /// 库不可用或记录为空时一律拒绝（fail closed）。
    #[test]
    fn fails_closed_without_records() {
        let app = app_with_records(&[]);
        assert!(!is_recorded_file_path(
            app.handle(),
            r"D:\downloads\anything.png"
        ));
    }
}

#[cfg(test)]
mod remove_quick_input_file_tests {
    use crate::db::{remove_quick_input_file, DbState};
    use std::path::Path;
    use std::sync::Mutex;
    use tauri::Manager;

    /// 内存库 + mock app：storage_path 指向测试目录。
    fn app_with_storage_dir(dir: &Path) -> tauri::App<tauri::test::MockRuntime> {
        let app = tauri::test::mock_app();
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
        )
        .unwrap();
        conn.execute(
            "INSERT INTO settings (key, value) VALUES ('storage_path', ?1)",
            rusqlite::params![dir.to_string_lossy()],
        )
        .unwrap();
        app.manage(DbState {
            conn: Mutex::new(conn),
        });
        app
    }

    /// 删除列表渲染过缩略图的短语时必须连同 <uuid>/thumbs/ 一起移除
    /// （回归：remove_dir 删不掉非空目录，缓存会把整个短语目录残留）。
    #[test]
    fn removes_phrase_dir_including_thumbs_cache() {
        let dir = std::env::temp_dir().join(format!(
            "copy-creator-remove-qi-{}",
            uuid::Uuid::new_v4()
        ));
        let app = app_with_storage_dir(&dir);
        let phrase_dir = dir.join("quick-input-files").join("uuid-1");
        std::fs::create_dir_all(phrase_dir.join("thumbs")).unwrap();
        std::fs::write(phrase_dir.join("img.png"), b"png").unwrap();
        std::fs::write(phrase_dir.join("thumbs").join("img.png"), b"thumb").unwrap();

        remove_quick_input_file(app.handle(), "quick-input-files/uuid-1/img.png");

        assert!(!phrase_dir.exists(), "短语目录应连同 thumbs/ 缓存一起删除");
        assert!(
            dir.join("quick-input-files").exists(),
            "quick-input-files 根目录必须保留"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    /// 根一级的旧式单文件路径只删文件本身，不动根目录。
    #[test]
    fn legacy_root_level_file_only_removes_the_file() {
        let dir = std::env::temp_dir().join(format!(
            "copy-creator-remove-qi-{}",
            uuid::Uuid::new_v4()
        ));
        let app = app_with_storage_dir(&dir);
        let legacy = dir.join("quick-input-files").join("legacy.md");
        std::fs::create_dir_all(&legacy.parent().unwrap()).unwrap();
        std::fs::write(&legacy, b"md").unwrap();

        remove_quick_input_file(app.handle(), "quick-input-files/legacy.md");

        assert!(!legacy.exists(), "旧式文件应被删除");
        assert!(
            dir.join("quick-input-files").exists(),
            "根目录必须保留"
        );
        std::fs::remove_dir_all(&dir).ok();
    }
}

