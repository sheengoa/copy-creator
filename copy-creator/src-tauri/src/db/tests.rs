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
        // 回归：80 字符上限按字符计，80 个 4 字节字符（emoji）达 320 字节，
        // 超过 NAME_MAX 255，创建目录报 os error 36——需按字节兜底。
        assert!(normalize_resource_group_name(Some(&"🎨".repeat(80))).is_err());
        // 80 个汉字 240 字节，仍在字节上限内，保持可用。
        assert_eq!(
            normalize_resource_group_name(Some(&"段".repeat(80))).unwrap(),
            "段".repeat(80)
        );
        // Windows 非法字符与保留名：Linux 上合法但跨平台同步会失败。
        assert!(normalize_resource_group_name(Some("a:b")).is_err());
        assert!(normalize_resource_group_name(Some("CON")).is_err());
        assert!(normalize_resource_group_name(Some("CON.txt")).is_err());
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
        // 层数与整条路径字节上限：防止深层多级分组把完整路径撑过 PATH_MAX。
        let deep_ok = vec!["组"; 15].join("/");
        assert_eq!(
            normalize_resource_folder_path(Some(&deep_ok)).unwrap(),
            deep_ok
        );
        let too_deep = vec!["组"; 17].join("/");
        assert!(normalize_resource_folder_path(Some(&too_deep)).is_err());
        let too_long = vec!["段".repeat(80); 16].join("/");
        assert!(normalize_resource_folder_path(Some(&too_long)).is_err());
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
        create_resource_group_inner, delete_resource_group_inner,
        forget_resource_records, get_clipboard_records_inner, get_resource_groups_inner,
        move_resource_group_inner, move_resource_records_inner, normalize_file_backed_text_records,
        read_resource_text_preview_file, ResourceTextPreview,
        RESOURCE_TEXT_DETAIL_LIMIT_BYTES, RESOURCE_TEXT_PREVIEW_TRUNCATE_BYTES,
        read_resource_text_detail_bounded,
        add_resource_annotation_inner, annotation_count, get_resource_annotations_inner,
        remove_resource_annotations_in_range_inner,
        read_text_file_content_inner, rename_resource_file_inner,
        reorder_resource_groups_inner, resolve_resource_file_path, resource_file_id,
        resource_folder_tree, resource_group_count_map, set_resource_note_inner,
        settle_external_resource_changes, simplify_windows_path,
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
                 pinned INTEGER NOT NULL DEFAULT 0,
                 resource_missing INTEGER NOT NULL DEFAULT 0
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
    fn moving_group_updates_image_content_and_video_resource_paths() {
        let (app, root) = test_app();
        let old_dir = root.join("Source").join("Mixed");
        std::fs::create_dir_all(&old_dir).unwrap();
        let image = old_dir.join("cover.png");
        let video = old_dir.join("clip.mp4");
        std::fs::write(&image, [1_u8]).unwrap();
        std::fs::write(&video, [2_u8]).unwrap();
        insert_typed_resource(
            &app,
            "image-record",
            "image",
            image.to_str().unwrap(),
            image.to_str().unwrap(),
        );
        insert_typed_resource(
            &app,
            "video-record",
            "file",
            video.to_str().unwrap(),
            video.to_str().unwrap(),
        );
        std::fs::create_dir_all(root.join("Target")).unwrap();

        move_resource_group_inner(
            app.handle(),
            "Source/Mixed".to_string(),
            "Target".to_string(),
        )
        .unwrap();

        let moved_image = root.join("Target/Mixed/cover.png");
        let moved_video = root.join("Target/Mixed/clip.mp4");
        let state = app.state::<DbState>();
        let conn = state.conn.lock().unwrap();
        let image_paths: (String, String) = conn
            .query_row(
                "SELECT content, resource_path FROM clipboard_records WHERE id = 'image-record'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(
            slash_normalized(&image_paths.0),
            slash_normalized(&moved_image.to_string_lossy())
        );
        assert_eq!(
            slash_normalized(&image_paths.1),
            slash_normalized(&moved_image.to_string_lossy())
        );
        let video_paths: (String, String) = conn
            .query_row(
                "SELECT content, resource_path FROM clipboard_records WHERE id = 'video-record'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(
            slash_normalized(&video_paths.0),
            slash_normalized(&moved_video.to_string_lossy())
        );
        assert_eq!(
            slash_normalized(&video_paths.1),
            slash_normalized(&moved_video.to_string_lossy())
        );
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
            ResourceTextPreview { content: "预览内容".to_string(), truncated: false }
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
    fn resource_text_preview_truncates_large_files_at_char_boundaries() {
        let (app, root) = test_app();
        // 「汉」占 3 字节：截断阈值（1 MB）不整除 3，截断点必然落在字符
        // 中间——读取必须回退到字符边界安全收尾，而不是像旧实现那样整单
        // 报错（大文件详情页曾因此显示「内容详情加载失败」）。
        let large = root.join("large.txt");
        std::fs::write(&large, "汉".repeat(700_000)).unwrap(); // 约 2 MB
        let preview = read_resource_text_preview_file(
            resolve_resource_file_path(app.handle(), large.to_string_lossy().as_ref()).unwrap(),
        )
        .unwrap();
        assert!(preview.truncated);
        assert!(
            preview.content.len() <= RESOURCE_TEXT_PREVIEW_TRUNCATE_BYTES as usize,
            "截断内容不得超过阈值"
        );
        assert_eq!(preview.content.len() % 3, 0, "截断点必须落在字符边界");
        assert!(preview.content.ends_with("汉"));
        cleanup(&root);
    }

    #[test]
    fn resource_text_preview_rejects_non_utf8_and_ignores_invalid_bytes_beyond_the_cut() {
        let (app, root) = test_app();
        // GBK 等非 UTF-8 文本：前 1 MB 内存在非法字节 → 与旧 read_to_string
        // 行为一致报错。截断回退必须以「末尾不完整字符」为界——曾用无界
        // 逐字节回退实现，整段非法内容会触发平方级重复校验冻结 UI。
        let gbk = root.join("gbk.txt");
        let mut bytes = "中文标题".as_bytes().to_vec();
        bytes.extend([0xB4, 0xF3]); // GBK「大」：单独看是非法 UTF-8 序列
        bytes.extend("正文内容".as_bytes());
        std::fs::write(&gbk, bytes).unwrap();
        assert!(read_resource_text_preview_file(
            resolve_resource_file_path(app.handle(), gbk.to_string_lossy().as_ref()).unwrap()
        )
        .is_err());

        // 非法字节位于截断点之后（读取范围只有前 1 MB）：前置合法部分
        // 照常截断展示，不受后续内容影响。
        let mixed = root.join("mixed.txt");
        let mut bytes = "汉".repeat(400_000).into_bytes(); // 1.2 MB 全合法
        bytes.push(0xFF);
        std::fs::write(&mixed, bytes).unwrap();
        let preview = read_resource_text_preview_file(
            resolve_resource_file_path(app.handle(), mixed.to_string_lossy().as_ref()).unwrap(),
        )
        .unwrap();
        assert!(preview.truncated);
        assert!(preview.content.ends_with("汉"));
        assert_eq!(preview.content.len() % 3, 0);
        cleanup(&root);
    }

    #[test]
    fn resource_text_detail_reads_full_content_and_rejects_over_limit() {
        let (app, root) = test_app();
        // 上限内整读：全文返回、不截断（预览命令对同文件只给前 1 MB）。
        let text = root.join("novel.txt");
        let body = "汉".repeat(400_000); // 1.2 MB
        std::fs::write(&text, &body).unwrap();
        let path = resolve_resource_file_path(app.handle(), text.to_string_lossy().as_ref())
            .unwrap();
        let detail =
            read_resource_text_detail_bounded(&path, RESOURCE_TEXT_DETAIL_LIMIT_BYTES).unwrap();
        assert!(!detail.truncated);
        assert_eq!(detail.content, body);

        // 超上限报错（前端据此回退 1 MB 截断预览并引导系统应用打开）；
        // 用小 limit 验证，不必真实写入 64 MB。
        let error = read_resource_text_detail_bounded(&path, 1024).unwrap_err();
        assert!(error.contains("系统应用"));

        // 非 UTF-8 内容与预览同口径拒绝。
        let gbk = root.join("gbk.txt");
        let mut bytes = b"plaintext".as_slice().to_vec();
        bytes.extend([0xB4, 0xF3]);
        std::fs::write(&gbk, bytes).unwrap();
        let gbk_path = resolve_resource_file_path(app.handle(), gbk.to_string_lossy().as_ref())
            .unwrap();
        assert!(read_resource_text_detail_bounded(&gbk_path, RESOURCE_TEXT_DETAIL_LIMIT_BYTES)
            .is_err());
        cleanup(&root);
    }

    #[test]
    fn resource_annotations_crud_validation_and_foreign_key_cascades() {
        let (app, root) = test_app();
        // 夹具表结构不含标注表：按 ensure_schema 同构补建并开启外键，
        // 级联行为（删记录随删、id 改写随迁）与运行时一致。
        {
            let state = app.state::<DbState>();
            let conn = state.conn.lock().unwrap();
            conn.execute_batch(
                "PRAGMA foreign_keys=ON;
                 CREATE TABLE resource_annotations (
                     id TEXT PRIMARY KEY,
                     record_id TEXT NOT NULL,
                     start_offset INTEGER NOT NULL,
                     length INTEGER NOT NULL,
                     kind TEXT NOT NULL,
                     anchor_text TEXT NOT NULL,
                     created_at TEXT NOT NULL,
                     FOREIGN KEY (record_id) REFERENCES clipboard_records(id)
                         ON DELETE CASCADE ON UPDATE CASCADE
                 );",
            )
            .unwrap();
            conn.execute(
                "INSERT INTO clipboard_records (id, type, content, created_at, storage_mode, resource_path)
                 VALUES ('rec-1', 'file', 'p.txt', '2026-01-01', 'resource', 'p.txt')",
                [],
            )
            .unwrap();
        }

        // 新增 + 按位置排序读取。
        add_resource_annotation_inner(app.handle(), "rec-1", 10, 4, "hl-y", "铃响七次").unwrap();
        add_resource_annotation_inner(app.handle(), "rec-1", 20, 6, "bold", "记得回头").unwrap();
        let list = get_resource_annotations_inner(app.handle(), "rec-1").unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].start_offset, 10);
        assert_eq!(list[0].record_id, "rec-1");

        // 输入校验：未知类型 / 非正长度 / 记录不存在（含非资源记录）。
        assert!(
            add_resource_annotation_inner(app.handle(), "rec-1", 0, 4, "strike", "x").is_err()
        );
        assert!(add_resource_annotation_inner(app.handle(), "rec-1", 0, 0, "bold", "x").is_err());
        assert!(
            add_resource_annotation_inner(app.handle(), "missing", 0, 4, "bold", "x").is_err()
        );

        // 范围清除：与选区部分重叠的标注整条移除，未触及的保留。
        let removed =
            remove_resource_annotations_in_range_inner(app.handle(), "rec-1", 12, 4).unwrap();
        assert_eq!(removed, 1);
        assert_eq!(get_resource_annotations_inner(app.handle(), "rec-1").unwrap().len(), 1);

        // id 改写（重命名/目录重定向/启动纠偏的共用路径）：外键
        // ON UPDATE CASCADE 让标注自动随迁，无需各处手写级联。
        {
            let state = app.state::<DbState>();
            let conn = state.conn.lock().unwrap();
            conn.execute("UPDATE clipboard_records SET id = 'rec-2' WHERE id = 'rec-1'", [])
                .unwrap();
        }
        assert!(get_resource_annotations_inner(app.handle(), "rec-1").unwrap().is_empty());
        assert_eq!(get_resource_annotations_inner(app.handle(), "rec-2").unwrap().len(), 1);

        // 删除记录：外键 ON DELETE CASCADE 标注清零。
        {
            let state = app.state::<DbState>();
            let conn = state.conn.lock().unwrap();
            conn.execute("DELETE FROM clipboard_records WHERE id = 'rec-2'", []).unwrap();
            assert_eq!(annotation_count(&conn, "rec-2"), 0);
        }
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
        std::fs::remove_file(&resolved).unwrap();
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
        // 字符数在 120 字内但 UTF-8 字节数超 NAME_MAX 的名称：给可读错误而非 os error 36
        let long_multibyte = "段".repeat(120);
        assert!(validate_resource_rename_stem(&long_multibyte, Path::new("/tmp/a.png")).is_err());
        let near_limit = "段".repeat(83);
        assert_eq!(
            validate_resource_rename_stem(&near_limit, Path::new("/tmp/a.png")).unwrap(),
            near_limit
        );
        // 保留名按首个点号前的主干判定：带扩展名的 CON.backup 旧整名比对会漏放
        assert!(validate_resource_rename_stem("CON.backup", Path::new("/tmp/a.txt")).is_err());
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
    fn save_stash_record_long_multibyte_content_fits_name_max() {
        // 回归（端到端）：内容派生名按 60 字符截断，长中文组装出的文件名
        // 267 字节超 NAME_MAX，真实写入报 os error 36——修复后必须成功落盘。
        let (app, root) = test_app();
        let content =
            "【全局设定】基础环境与质感：深夜大排档后厨的灶台区，不锈钢灶台与排烟罩，真实物理质感，灶火橙色光恒定；全片只有这一口炒锅在灶上。"
                .repeat(5);
        let result = crate::clipboard::save_stash_record_inner(
            app.handle(),
            None,
            content,
            Vec::new(),
            Some("resource".to_string()),
            None,
            None,
        )
        .unwrap();

        let resource_path = Path::new(result["resource_path"].as_str().unwrap());
        assert!(resource_path.is_file());
        // 每个路径组件（含自动派生名的管理文件与写入用临时名形态）不超单文件名上限
        for component in resource_path.components() {
            if let Some(name) = component.as_os_str().to_str() {
                assert!(name.len() <= 255, "路径组件超限: {name}");
            }
        }
        cleanup(&root);
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

        let (added, removed) = crate::db::sync_resource_library(app.handle());
        assert!(added >= 1);
        assert!(removed >= 1, "幽灵记录应计入清退数");

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
    fn settle_redirects_moved_mixed_media_directory_to_another_group() {
        // 文件管理器把包含视频和图片的分组移到另一层路径时，两个旧记录
        // 都应按相对路径重定向；图片不能被误标记为缺失或作为新文件重建。
        let (app, root) = test_app();
        let old_dir = root.join("待整理").join("素材");
        std::fs::create_dir_all(old_dir.join("原图")).unwrap();
        let video = old_dir.join("镜头.mp4");
        let image = old_dir.join("原图").join("封面.png");
        std::fs::write(&video, [1, 2]).unwrap();
        std::fs::write(&image, [3, 4]).unwrap();
        insert_typed_resource(
            &app,
            "video-record",
            "file",
            video.to_str().unwrap(),
            video.to_str().unwrap(),
        );
        insert_typed_resource(
            &app,
            "image-record",
            "image",
            image.to_str().unwrap(),
            image.to_str().unwrap(),
        );

        let new_dir = root.join("已完成").join("成片素材");
        std::fs::create_dir_all(new_dir.parent().unwrap()).unwrap();
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
        assert_eq!(records.len(), 2, "移动后应保留两条原记录");
        for (old_id, expected_path, expected_kind) in [
            ("video-record", new_dir.join("镜头.mp4"), "video"),
            (
                "image-record",
                new_dir.join("原图").join("封面.png"),
                "image",
            ),
        ] {
            let record = records
                .iter()
                .find(|record| record["resource_path"].as_str() == expected_path.to_str())
                .unwrap_or_else(|| panic!("应找到重定向后的资源 {expected_path:?}: {records:?}"));
            assert_eq!(record["id"].as_str(), Some(resource_file_id(&expected_path).as_str()));
            assert_eq!(record["content"].as_str(), expected_path.to_str());
            assert_eq!(record["resource_kind"].as_str(), Some(expected_kind));
            assert_eq!(record["resource_missing"].as_bool(), Some(false));
            assert_ne!(record["id"].as_str(), Some(old_id));
        }
        cleanup(&root);
    }

    #[test]
    fn moved_file_backed_text_resources_keep_their_content() {
        let (app, root) = test_app();
        let body = "Original text resource body";
        let old_folder = root.join("old-folder");
        let old_nested_text = old_folder.join("notes.txt");
        std::fs::create_dir_all(&old_folder).unwrap();
        std::fs::write(&old_nested_text, body).unwrap();
        insert_typed_resource(
            &app,
            "nested-text",
            "text",
            body,
            old_nested_text.to_str().unwrap(),
        );
        let new_folder = root.join("new-folder");
        std::fs::rename(&old_folder, &new_folder).unwrap();
        settle_external_resource_changes(app.handle(), &[old_folder, new_folder.clone()]);

        let old_single = root.join("old-single").join("notes.txt");
        std::fs::create_dir_all(old_single.parent().unwrap()).unwrap();
        std::fs::write(&old_single, body).unwrap();
        insert_typed_resource(
            &app,
            "single-text",
            "text",
            body,
            old_single.to_str().unwrap(),
        );
        let new_single = root.join("new-single").join("notes.txt");
        std::fs::create_dir_all(new_single.parent().unwrap()).unwrap();
        std::fs::rename(&old_single, &new_single).unwrap();
        settle_external_resource_changes(app.handle(), &[old_single, new_single.clone()]);

        let state = app.state::<DbState>();
        let conn = state.conn.lock().unwrap();
        for (path, id) in [
            (new_folder.join("notes.txt"), "nested-text"),
            (new_single, "single-text"),
        ] {
            let (content, resource_path): (String, String) = conn
                .query_row(
                    "SELECT content, resource_path FROM clipboard_records WHERE id = ?1",
                    [resource_file_id(&path)],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .unwrap_or_else(|error| panic!("record {id} should be relocated: {error}"));
            assert_eq!(content, body, "moving a text resource must preserve its content");
            assert_eq!(resource_path, path.to_string_lossy());
        }
        drop(conn);
        cleanup(&root);
    }

    #[test]
    fn settle_redirects_uniquely_moved_audio_and_image_files() {
        let (app, root) = test_app();
        let old_dir = root.join("1029").join("打扮").join("新建文件夹");
        std::fs::create_dir_all(&old_dir).unwrap();
        let old_female = old_dir.join("女.mp3");
        let old_male = old_dir.join("男.mp3");
        let old_image = old_dir.join("封面.png");
        std::fs::write(&old_female, [1, 2, 3]).unwrap();
        std::fs::write(&old_male, [4, 5, 6]).unwrap();
        std::fs::write(&old_image, [7, 8, 9]).unwrap();
        insert_typed_resource(
            &app,
            "female-audio",
            "file",
            old_female.to_str().unwrap(),
            old_female.to_str().unwrap(),
        );
        insert_typed_resource(
            &app,
            "male-audio",
            "file",
            old_male.to_str().unwrap(),
            old_male.to_str().unwrap(),
        );
        insert_typed_resource(
            &app,
            "cover-image",
            "image",
            old_image.to_str().unwrap(),
            old_image.to_str().unwrap(),
        );

        let new_female = old_dir.parent().unwrap().join("女.mp3");
        let new_male = old_dir.parent().unwrap().join("男.mp3");
        let new_image = old_dir.parent().unwrap().join("封面.png");
        std::fs::rename(&old_female, &new_female).unwrap();
        std::fs::rename(&old_male, &new_male).unwrap();
        std::fs::rename(&old_image, &new_image).unwrap();
        settle_external_resource_changes(
            app.handle(),
            &[
                old_dir.clone(),
                old_female.clone(),
                old_male.clone(),
                old_image.clone(),
                new_female.clone(),
                new_male.clone(),
                new_image.clone(),
            ],
        );

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
        assert_eq!(records.len(), 3, "移动后应保留原资源记录，不应重建为新记录");
        for (old_id, new_path, expected_kind) in [
            ("female-audio", new_female, "audio"),
            ("male-audio", new_male, "audio"),
            ("cover-image", new_image, "image"),
        ] {
            let record = records
                .iter()
                .find(|record| record["resource_path"].as_str() == new_path.to_str())
                .unwrap_or_else(|| panic!("应重定向至 {new_path:?}: {records:?}"));
            assert_eq!(record["id"].as_str(), Some(resource_file_id(&new_path).as_str()));
            assert_eq!(record["content"].as_str(), new_path.to_str());
            assert_eq!(record["resource_kind"].as_str(), Some(expected_kind));
            assert_eq!(record["resource_missing"].as_bool(), Some(false));
            assert_ne!(record["id"].as_str(), Some(old_id));
        }
        cleanup(&root);
    }

    #[test]
    fn settle_does_not_redirect_when_same_name_has_multiple_arrivals() {
        let (app, root) = test_app();
        let old_dir = root.join("old-group");
        std::fs::create_dir_all(&old_dir).unwrap();
        let old = old_dir.join("女.mp3");
        std::fs::write(&old, [1, 2, 3]).unwrap();
        insert_typed_resource(
            &app,
            "ambiguous-audio",
            "file",
            old.to_str().unwrap(),
            old.to_str().unwrap(),
        );
        let first = root.join("group-a").join("女.mp3");
        let second = root.join("group-b").join("女.mp3");
        std::fs::create_dir_all(first.parent().unwrap()).unwrap();
        std::fs::create_dir_all(second.parent().unwrap()).unwrap();
        std::fs::write(&first, [4, 5, 6]).unwrap();
        std::fs::write(&second, [7, 8, 9]).unwrap();
        std::fs::remove_file(&old).unwrap();

        settle_external_resource_changes(
            app.handle(),
            &[old, first.clone(), second.clone()],
        );

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
        assert_eq!(records.len(), 2, "歧义候选应按新文件发现处理，不继承旧记录");
        assert!(records.iter().all(|record| record["id"] != "ambiguous-audio"));
        assert!(records.iter().any(|record| record["resource_path"].as_str() == first.to_str()));
        assert!(records.iter().any(|record| record["resource_path"].as_str() == second.to_str()));
        cleanup(&root);
    }

    #[test]
    fn sync_resource_library_recovers_moved_audio_after_missed_watch_events() {
        let (app, root) = test_app();
        let old_dir = root.join("1029").join("打扮").join("新建文件夹");
        std::fs::create_dir_all(&old_dir).unwrap();
        let old_female = old_dir.join("女.mp3");
        let old_male = old_dir.join("男.mp3");
        std::fs::write(&old_female, [1, 2, 3]).unwrap();
        std::fs::write(&old_male, [4, 5, 6]).unwrap();
        insert_typed_resource(
            &app,
            "female-audio",
            "file",
            old_female.to_str().unwrap(),
            old_female.to_str().unwrap(),
        );
        insert_typed_resource(
            &app,
            "male-audio",
            "file",
            old_male.to_str().unwrap(),
            old_male.to_str().unwrap(),
        );
        let new_female = old_dir.parent().unwrap().join("女.mp3");
        let new_male = old_dir.parent().unwrap().join("男.mp3");
        std::fs::rename(&old_female, &new_female).unwrap();
        std::fs::rename(&old_male, &new_male).unwrap();

        crate::db::sync_resource_library(app.handle());

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
        assert_eq!(records.len(), 2, "对账应恢复原音频记录，避免清退后重新建档");
        for (old_id, new_path) in [("female-audio", new_female), ("male-audio", new_male)] {
            let record = records
                .iter()
                .find(|record| record["resource_path"].as_str() == new_path.to_str())
                .unwrap_or_else(|| panic!("对账应恢复到 {new_path:?}: {records:?}"));
            assert_eq!(record["resource_kind"].as_str(), Some("audio"));
            assert_eq!(record["resource_missing"].as_bool(), Some(false));
            assert_ne!(record["id"].as_str(), Some(old_id));
        }
        cleanup(&root);
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
    fn normalize_file_backed_text_records_repairs_edited_demotions() {
        // 回归锚点：详情页编辑保存曾把文件承载文本资源降级为 text/link 并把
        // 全文写进 content，粘贴/拖出/预览从此绕过文件，外部编辑文件后取到
        // 过期内容。启动归一须把「resource_path 指向存在的文本扩展名文件」
        // 的降级行恢复为 file 形态（content 归位为路径）；文件缺失或非文本
        // 扩展名的行保持原样，交由展示层摘要兜底。
        let (app, root) = test_app();
        let live = root.join("edited.txt");
        std::fs::write(&live, "最新正文\n").unwrap();
        insert_typed_resource(
            &app,
            "demoted-txt",
            "text",
            "过期的正文副本",
            live.to_str().unwrap(),
        );
        insert_typed_resource(
            &app,
            "demoted-link",
            "link",
            "https://example.com/旧文案",
            live.to_str().unwrap(),
        );
        let missing = root.join("gone.txt");
        insert_typed_resource(&app, "demoted-missing", "text", "正文", missing.to_str().unwrap());
        let binary = root.join("raw.dat");
        std::fs::write(&binary, b"\x00\x01").unwrap();
        insert_typed_resource(&app, "demoted-dat", "text", "正文", binary.to_str().unwrap());

        {
            let state = app.state::<DbState>();
            let conn = state.conn.lock().unwrap();
            let normalized = normalize_file_backed_text_records(&conn);
            assert_eq!(normalized, 2, "仅存在的文本扩展名行参与归一");
            for id in ["demoted-txt", "demoted-link"] {
                let (record_type, content): (String, String) = conn
                    .query_row(
                        "SELECT type, content FROM clipboard_records WHERE id = ?1",
                        [&id],
                        |row| Ok((row.get(0)?, row.get(1)?)),
                    )
                    .unwrap();
                assert_eq!(record_type, "file", "{id} 应回归 file 形态");
                assert_eq!(
                    slash_normalized(&content),
                    slash_normalized(live.to_str().unwrap()),
                    "{id} 的 content 应归位为文件路径",
                );
            }
            let remaining_demoted: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM clipboard_records
                     WHERE id IN ('demoted-missing', 'demoted-dat') AND type <> 'file'",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(remaining_demoted, 2, "文件缺失/非文本扩展名的行保持原样");
        }
        cleanup(&root);
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

    // ==================== 缺失追溯与清理 ====================

    fn insert_missing_resource(
        app: &tauri::App<tauri::test::MockRuntime>,
        id: &str,
        resource_path: &Path,
        missing: i64,
    ) {
        let state = app.state::<DbState>();
        let conn = state.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO clipboard_records
             (id, type, content, created_at, group_name, storage_mode, resource_path, resource_missing)
             VALUES (?1, 'file', ?2, '2026-08-01T00:00:00Z', '', 'resource', ?3, ?4)",
            (
                id,
                resource_path.to_string_lossy().as_ref(),
                resource_path.to_string_lossy().as_ref(),
                missing,
            ),
        )
        .unwrap();
    }

    fn resource_missing_flag(app: &tauri::App<tauri::test::MockRuntime>, id: &str) -> Option<i64> {
        let state = app.state::<DbState>();
        let conn = state.conn.lock().unwrap();
        conn.query_row(
            "SELECT COALESCE(resource_missing, 0) FROM clipboard_records WHERE id = ?1",
            [id],
            |row| row.get(0),
        )
        .ok()
    }

    #[test]
    fn recheck_missing_resources_recovers_returned_files_and_reports_rest() {
        let (app, root) = test_app();
        let back = root.join("back.txt");
        std::fs::write(&back, b"back").unwrap();
        let gone = root.join("gone.txt");
        insert_missing_resource(&app, crate::db::resource_file_id(&back).as_str(), &back, 1);
        insert_missing_resource(&app, "uuid-gone", &gone, 1);

        let summary = crate::db::recheck_missing_resources_internal(app.handle()).unwrap();
        assert!(summary.library_accessible);
        assert_eq!(summary.recovered, 1);
        assert_eq!(summary.total_resources, 2);
        assert_eq!(summary.still_missing.len(), 1);
        assert_eq!(summary.still_missing[0].id, "uuid-gone");
        assert_eq!(summary.still_missing[0].name, "gone.txt");
        assert_eq!(
            resource_missing_flag(&app, crate::db::resource_file_id(&back).as_str()),
            Some(0)
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn recheck_missing_resources_reports_offline_library() {
        let (app, root) = test_app();
        // 库目录会被 get_resource_library_dir 尝试自动重建，存储离线要用
        // 「无法创建」的路径模拟：让父级是一个文件——mkdir 在两个平台都
        // 必然失败（原 /proc 方案是 Linux 专属，Windows 会建到当前盘符下）。
        let blocker = root.join("not-a-dir");
        std::fs::write(&blocker, b"x").unwrap();
        let offline_root = blocker.join("library");
        {
            let state = app.state::<DbState>();
            let conn = state.conn.lock().unwrap();
            conn.execute(
                "UPDATE settings SET value = ?1 WHERE key = 'resource_library_path'",
                [offline_root.to_string_lossy().as_ref()],
            )
            .unwrap();
        }
        let gone = root.join("gone.txt");
        insert_missing_resource(&app, "uuid-gone", &gone, 1);

        let summary = crate::db::recheck_missing_resources_internal(app.handle()).unwrap();
        assert!(!summary.library_accessible);
        assert_eq!(summary.recovered, 0);
        assert_eq!(summary.still_missing.len(), 1);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn trace_candidates_list_all_same_named_library_files() {
        let (app, root) = test_app();
        let lost = root.join("lost");
        std::fs::create_dir_all(&lost).unwrap();
        let backup_a = root.join("备用");
        std::fs::create_dir_all(&backup_a).unwrap();
        let backup_b = root.join("归档");
        std::fs::create_dir_all(&backup_b).unwrap();
        let same_a = backup_a.join("A组.mp4");
        let same_b = backup_b.join("A组.mp4");
        std::fs::write(&same_a, [1]).unwrap();
        std::fs::write(&same_b, [2]).unwrap();
        let missing_path = lost.join("A组.mp4");
        insert_missing_resource(
            &app,
            crate::db::resource_file_id(&missing_path).as_str(),
            &missing_path,
            1,
        );

        let record_id = crate::db::resource_file_id(&missing_path);
        let mut candidates =
            crate::db::find_resource_trace_candidates_internal(app.handle(), record_id.as_str())
                .unwrap();
        candidates.sort();
        let mut expected = vec![
            same_a.to_string_lossy().to_string(),
            same_b.to_string_lossy().to_string(),
        ];
        expected.sort();
        assert_eq!(candidates, expected);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn trace_relink_rewrites_id_path_and_clears_missing_flag() {
        let (app, root) = test_app();
        let old_dir = root.join("A组");
        std::fs::create_dir_all(&old_dir).unwrap();
        let old_path = old_dir.join("B组02.mp4");
        let old_id = crate::db::resource_file_id(&old_path);
        insert_missing_resource(&app, old_id.as_str(), &old_path, 1);

        let backup_dir = root.join("备用");
        std::fs::create_dir_all(&backup_dir).unwrap();
        let target = backup_dir.join("B组02.mp4");
        std::fs::write(&target, [9]).unwrap();
        // 目标路径上先有一条自动发现的幽灵行（同一文件被建了新记录）。
        let ghost_id = crate::db::resource_file_id(&target);
        insert_missing_resource(&app, ghost_id.as_str(), &target, 0);

        // 旧 id 上挂一条划选标注：id 级联改写必须经外键随迁标注
        // （resource_annotations ON UPDATE CASCADE + 连接外键开关）。
        {
            let state = app.state::<DbState>();
            let conn = state.conn.lock().unwrap();
            conn.execute_batch(
                "PRAGMA foreign_keys=ON;
                 CREATE TABLE resource_annotations (
                     id TEXT PRIMARY KEY,
                     record_id TEXT NOT NULL,
                     start_offset INTEGER NOT NULL,
                     length INTEGER NOT NULL,
                     kind TEXT NOT NULL,
                     anchor_text TEXT NOT NULL,
                     created_at TEXT NOT NULL,
                     FOREIGN KEY (record_id) REFERENCES clipboard_records(id)
                         ON DELETE CASCADE ON UPDATE CASCADE
                 );",
            )
            .unwrap();
            conn.execute(
                "INSERT INTO resource_annotations
                 (id, record_id, start_offset, length, kind, anchor_text, created_at)
                 VALUES ('ann-1', ?1, 0, 3, 'bold', 'B组', '2026-08-01T00:00:00Z')",
                [old_id.as_str()],
            )
            .unwrap();
        }

        let result = crate::db::trace_relink_resource_internal(
            app.handle(),
            old_id.as_str(),
            target.to_string_lossy().as_ref(),
        )
        .unwrap();
        assert_eq!(result["id"], ghost_id);
        assert_eq!(result["resource_path"], target.to_string_lossy().as_ref());
        assert_eq!(slash_normalized(result["resource_relative_path"].as_str().unwrap()), "备用/B组02.mp4");

        let state = app.state::<DbState>();
        let conn = state.conn.lock().unwrap();
        // 幽灵行让位：同路径只剩重链后的一行，携带旧记录的身份重写。
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM clipboard_records WHERE resource_path = ?1",
                [target.to_string_lossy().as_ref()],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
        drop(conn);
        assert_eq!(
            resource_missing_flag(&app, ghost_id.as_str()),
            Some(0),
            "重链后缺失标志必须清零"
        );
        // 标注随 id 迁移：旧 id 下不再有标注，新 id 恰好一条。
        {
            let state = app.state::<DbState>();
            let conn = state.conn.lock().unwrap();
            let old_count: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM resource_annotations WHERE record_id = ?1",
                    [old_id.as_str()],
                    |row| row.get(0),
                )
                .unwrap();
            let new_count: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM resource_annotations WHERE record_id = ?1",
                    [ghost_id.as_str()],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!((old_count, new_count), (0, 1), "标注必须随 id 级联迁移");
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn trace_relink_copies_external_file_into_record_group_with_suffix() {
        let (app, root) = test_app();
        let group_dir = root.join("分组1");
        std::fs::create_dir_all(&group_dir).unwrap();
        let old_path = group_dir.join("video.mp4");
        let old_id = crate::db::resource_file_id(&old_path);
        insert_missing_resource(&app, old_id.as_str(), &old_path, 1);

        let external_dir = root.parent().unwrap().join("trace-external-src");
        std::fs::create_dir_all(&external_dir).unwrap();
        let external = external_dir.join("video.mp4");
        std::fs::write(&external, [7]).unwrap();

        // 无冲突：复制入原分组原文件名。
        let result = crate::db::trace_relink_resource_internal(
            app.handle(),
            old_id.as_str(),
            external.to_string_lossy().as_ref(),
        )
        .unwrap();
        assert!(old_path.is_file(), "库外文件必须复制入库");
        assert!(external.is_file(), "用户选中的原文件必须保留");
        assert_eq!(slash_normalized(result["resource_relative_path"].as_str().unwrap()), "分组1/video.mp4");
        assert_eq!(resource_missing_flag(&app, old_id.as_str()), Some(0));

        // 同名冲突：自动加序号，记录跟随最终落位路径。
        let old_path2 = group_dir.join("clip.mp4");
        let old_id2 = crate::db::resource_file_id(&old_path2);
        insert_missing_resource(&app, old_id2.as_str(), &old_path2, 1);
        std::fs::write(&old_path2, b"occupied").unwrap();
        let external2 = external_dir.join("clip.mp4");
        std::fs::write(&external2, [3]).unwrap();
        let result2 = crate::db::trace_relink_resource_internal(
            app.handle(),
            old_id2.as_str(),
            external2.to_string_lossy().as_ref(),
        )
        .unwrap();
        let final_relative = result2["resource_relative_path"].as_str().unwrap();
        assert_eq!(slash_normalized(final_relative), "分组1/clip (1).mp4");
        assert!(group_dir.join("clip (1).mp4").is_file());
        assert_eq!(
            resource_missing_flag(&app, result2["id"].as_str().unwrap()),
            Some(0)
        );

        // 非缺失记录拒绝重链。
        let alive = group_dir.join("alive.txt");
        std::fs::write(&alive, b"x").unwrap();
        let alive_id = crate::db::resource_file_id(&alive);
        insert_missing_resource(&app, alive_id.as_str(), &alive, 0);
        assert!(
            crate::db::trace_relink_resource_internal(
                app.handle(),
                alive_id.as_str(),
                external.to_string_lossy().as_ref()
            )
            .is_err()
        );

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&external_dir);
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
                pinned INTEGER NOT NULL DEFAULT 0,
                resource_missing INTEGER NOT NULL DEFAULT 0
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

    /// 相对当前时间生成"新鲜"夹具：硬编码日期会随真实时间流逝跌出保留期
    /// （默认 1 个月），夹具自己变成超期记录（2026-09-18 在 10-18 起爆炸，
    /// v0.3.18 CI 首次暴露）。超期夹具硬编码过去日期则是安全的。
    fn hours_ago_rfc3339(hours: i64) -> String {
        (chrono::Utc::now() - chrono::Duration::hours(hours)).to_rfc3339()
    }

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
        // 两条超期（1 年前）：一条收藏、一条普通；一条新鲜普通记录作对照
        //（相对当前时间生成，避免夹具随真实时间过期，见 hours_ago_rfc3339）。
        insert_record(&app, "old-pinned", "2025-09-01T00:00:00Z");
        insert_record(&app, "old-plain", "2025-09-01T00:00:00Z");
        insert_record(&app, "fresh-plain", &hours_ago_rfc3339(1));
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
        archive_resource_record_to_trash, delete_clipboard_records_internal, ensure_schema,
        list_trash_items_internal, discover_external_resource_files, get_clipboard_records_inner,
        prune_old_records, purge_trash_internal,
        register_delete_in_flight, restore_trash_item_internal, resource_file_id,
        settle_external_resource_changes, sync_resource_library, DbState, RestoreOutcome,
    };
    use crate::db::trash_backend::{fake_count, fake_send};
    use rusqlite::params;
    use std::path::{Path, PathBuf};
    use std::sync::Mutex;
    use tauri::Manager;

    const PNG_BYTES: [u8; 84] = [
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48,
        0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00,
        0x00, 0x1F, 0x15, 0xC4, 0x89, 0x00, 0x00, 0x00, 0x0A, 0x49, 0x44, 0x41, 0x54, 0x78,
        0x9C, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00,
        0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    ];

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

    // 应用内删除资源记录：文件移入系统回收站（fake 中有条目、原位消失）、
    // trash_items 落一行、clipboard_records 无行；恢复后文件回原位、记录
    // 整行回插（分组/备注经 resource_path 与元数据保留）。
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
        assert_eq!(fake_count(&file), 1, "文件应移入系统回收站（fake）");
        let items = list_trash_items_internal(&handle).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["file_name"], serde_json::json!("报价.pdf"));
        assert_eq!(items[0]["original_group"], serde_json::json!("项目资料"));
        assert_eq!(items[0]["has_file"], serde_json::Value::Bool(true));
        let trash_id = items[0]["id"].as_str().unwrap().to_string();

        restore_trash_item_internal(&handle, &trash_id).unwrap();

        assert!(file.exists());
        assert_eq!(std::fs::read(&file).unwrap(), b"pdf");
        assert_eq!(fake_count(&file), 0, "恢复后系统回收站条目应随之消失");
        assert_eq!(record_count(&app, "r1"), 1);
        assert!(list_trash_items_internal(&handle).unwrap().is_empty());
    }

    // 历史回收桶遗留（迁移前的旧条目）：恢复走旧桶路径，文件移回原位、
    // 桶目录清理。
    #[test]
    fn legacy_bucket_restore_moves_file_back_to_original() {
        let (app, library) = trash_test_app();
        let handle = app.handle().clone();
        let group_dir = library.join("组");
        std::fs::create_dir_all(&group_dir).unwrap();
        let file = group_dir.join("doc.txt");
        std::fs::write(&file, b"old").unwrap();

        // 历史形态：trash_items 行 + 库外 sibling 桶内的文件（迁移前状态）。
        let sub = format!(
            "{}-{}",
            chrono::Utc::now().timestamp_millis(),
            uuid::Uuid::new_v4().simple()
        );
        let bucket_file = library
            .parent()
            .unwrap()
            .join(format!(
                ".{}.trash/.trash/{sub}",
                library.file_name().and_then(|n| n.to_str()).unwrap()
            ))
            .join("doc.txt");
        std::fs::create_dir_all(bucket_file.parent().unwrap()).unwrap();
        std::fs::write(&bucket_file, b"old").unwrap();
        {
            let record_json = serde_json::json!({
                "id": "r1", "type": "file", "content": file.to_string_lossy(),
                "created_at": "2026-09-19T00:00:00Z", "group_name": "组",
                "storage_mode": "resource", "resource_path": file.to_string_lossy(),
                "resource_external": 1, "attachments": "[]",
            });
            let state = app.state::<DbState>();
            let conn = state.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO trash_items
                 (id, record_id, record_json, file_name, original_group, original_path, trash_dir, trashed_at, trashed_ms)
                 VALUES ('t1', 'r1', ?1, 'doc.txt', '组', ?2, ?3, '2026-09-29T00:00:00Z', 0)",
                params![
                    record_json.to_string(),
                    file.to_string_lossy().as_ref(),
                    format!(".trash/{sub}"),
                ],
            )
            .unwrap();
        }
        std::fs::remove_file(&file).unwrap();

        let trash_id = list_trash_items_internal(&handle).unwrap()[0]["id"]
            .as_str()
            .unwrap()
            .to_string();
        restore_trash_item_internal(&handle, &trash_id).unwrap();

        assert!(file.exists(), "历史桶文件应移回原位");
        assert_eq!(std::fs::read(&file).unwrap(), b"old");
        assert!(!bucket_file.exists(), "桶内副本应清位");
        let state = app.state::<DbState>();
        let conn = state.conn.lock().unwrap();
        let stored_path: String = conn
            .query_row(
                "SELECT resource_path FROM clipboard_records WHERE id = 'r1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(Path::new(&stored_path), file.as_path());
    }

    // 恢复三态之 Relinked：入回收站前文件已丢失（仅记录行入桶），库内
    // 别处存在唯一同名文件时，记录改指现存文件（记录跟随文件，不移动
    // 用户整理好的目录结构）。
    #[test]
    fn restore_relinks_to_only_same_named_file_in_library() {
        let (app, library) = trash_test_app();
        let handle = app.handle().clone();
        let group_dir = library.join("项目资料");
        std::fs::create_dir_all(&group_dir).unwrap();
        let file = group_dir.join("报价.pdf");
        std::fs::write(&file, b"pdf").unwrap();
        insert_external_record(&app, "r1", &file, &[]);

        // 先删文件制造"文件已不在磁盘"，再入回收站 → 仅记录行入桶。
        std::fs::remove_file(&file).unwrap();
        delete_clipboard_records_internal(&handle, &["r1".to_string()]).unwrap();
        let items = list_trash_items_internal(&handle).unwrap();
        assert_eq!(items.len(), 1);
        let trash_id = items[0]["id"].as_str().unwrap().to_string();

        // 库内别处出现唯一同名文件（thumbs 分组）。
        let elsewhere = library.join("thumbs").join("报价.pdf");
        std::fs::create_dir_all(elsewhere.parent().unwrap()).unwrap();
        std::fs::write(&elsewhere, b"pdf2").unwrap();

        let outcome = restore_trash_item_internal(&handle, &trash_id).unwrap();
        assert!(matches!(outcome, RestoreOutcome::Relinked));
        // 文件不被移动，记录改指现存文件。
        assert!(elsewhere.exists());
        assert!(!file.exists());
        let state = app.state::<DbState>();
        let conn = state.conn.lock().unwrap();
        let (content, resource_path): (String, String) = conn
            .query_row(
                "SELECT content, resource_path FROM clipboard_records WHERE id = 'r1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(Path::new(&content), elsewhere.as_path());
        assert_eq!(Path::new(&resource_path), elsewhere.as_path());
    }

    // 恢复三态之 MetadataOnly：文件已丢失且库内无同名候选，仅恢复记录
    // 元数据（保持原路径），outcome 如实标记。
    #[test]
    fn restore_reports_metadata_only_when_file_is_gone() {
        let (app, library) = trash_test_app();
        let handle = app.handle().clone();
        let group_dir = library.join("组");
        std::fs::create_dir_all(&group_dir).unwrap();
        let file = group_dir.join("丢失.png");
        std::fs::write(&file, b"png").unwrap();
        insert_external_record(&app, "r1", &file, &[]);

        std::fs::remove_file(&file).unwrap();
        delete_clipboard_records_internal(&handle, &["r1".to_string()]).unwrap();
        let trash_id = list_trash_items_internal(&handle).unwrap()[0]["id"]
            .as_str()
            .unwrap()
            .to_string();

        let outcome = restore_trash_item_internal(&handle, &trash_id).unwrap();
        assert!(matches!(outcome, RestoreOutcome::MetadataOnly));
        assert_eq!(record_count(&app, "r1"), 1);
        let state = app.state::<DbState>();
        let conn = state.conn.lock().unwrap();
        let stored_path: String = conn
            .query_row(
                "SELECT resource_path FROM clipboard_records WHERE id = 'r1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(Path::new(&stored_path), file.as_path());
        assert!(!file.exists());
    }

    // 三态边界：.trash 无文件但原位已有同名文件（用户后来放了回去），
    // 视同 Restored，不做移动也不改指别处。
    #[test]
    fn restore_counts_existing_original_file_as_restored() {
        let (app, library) = trash_test_app();
        let handle = app.handle().clone();
        let group_dir = library.join("组");
        std::fs::create_dir_all(&group_dir).unwrap();
        let file = group_dir.join("说明.txt");
        std::fs::write(&file, b"old").unwrap();
        insert_external_record(&app, "r1", &file, &[]);

        std::fs::remove_file(&file).unwrap();
        delete_clipboard_records_internal(&handle, &["r1".to_string()]).unwrap();
        let trash_id = list_trash_items_internal(&handle).unwrap()[0]["id"]
            .as_str()
            .unwrap()
            .to_string();
        // 原位被放回同名文件（内容不同）。
        std::fs::write(&file, b"new").unwrap();

        let outcome = restore_trash_item_internal(&handle, &trash_id).unwrap();
        assert!(matches!(outcome, RestoreOutcome::Restored));
        assert_eq!(std::fs::read(&file).unwrap(), b"new");
        assert_eq!(record_count(&app, "r1"), 1);
    }


    // 对账安全边界 1：扫描结果为空（库目录缺失/不可读）时禁止清退——
    // 否则挂载异常/目录被外部整移会把整个库的记录一次性清光（真实事故）。
    #[test]
    fn sync_skips_purge_when_library_scan_is_empty() {
        let (app, library) = trash_test_app();
        let handle = app.handle().clone();
        let group_dir = library.join("组");
        std::fs::create_dir_all(&group_dir).unwrap();
        let file = group_dir.join("a.png");
        std::fs::write(&file, b"png").unwrap();
        insert_external_record(&app, "r1", &file, &[]);

        // 整个库目录消失（挂载/误删场景）：对账必须原样保留记录。
        std::fs::remove_dir_all(&library).unwrap();
        sync_resource_library(&handle);

        assert_eq!(record_count(&app, "r1"), 1);
    }

    // 对账安全边界 2：单次拟清退过半且达阈值时触发安全阀中止，防止
    // 扫描口径异常导致整库清退。
    #[test]
    fn sync_aborts_mass_purge_via_safety_valve() {
        let (app, library) = trash_test_app();
        let handle = app.handle().clone();
        let group_dir = library.join("组");
        std::fs::create_dir_all(&group_dir).unwrap();
        for index in 0..12 {
            let file = group_dir.join(format!("f{index}.png"));
            std::fs::write(&file, b"png").unwrap();
            insert_external_record(&app, &format!("r{index}"), &file, &[]);
        }
        // 12 个文件删掉 11 个：拟清退 11/12，触发安全阀，全部保留。
        for index in 0..11 {
            std::fs::remove_file(group_dir.join(format!("f{index}.png"))).unwrap();
        }
        sync_resource_library(&handle);

        let state = app.state::<DbState>();
        let conn = state.conn.lock().unwrap();
        let total: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM clipboard_records WHERE storage_mode = 'resource'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(total, 12);
    }

    // 对账兜底链路：文件丢失的记录经对账转入应用内回收站（而非硬删除），
    // 恢复时按 metadata_only 如实回插并提示缺失。
    #[test]
    fn sync_moves_dead_records_to_trash_and_restore_reports_missing() {
        let (app, library) = trash_test_app();
        let handle = app.handle().clone();
        let group_dir = library.join("组");
        std::fs::create_dir_all(&group_dir).unwrap();
        let alive = group_dir.join("存活.png");
        std::fs::write(&alive, b"1").unwrap();
        insert_external_record(&app, "r1", &alive, &[]);
        let dead = group_dir.join("丢失.png");
        std::fs::write(&dead, b"2").unwrap();
        insert_external_record(&app, "r2", &dead, &[]);
        std::fs::remove_file(&dead).unwrap();

        sync_resource_library(&handle);

        // r2 被清退但进入回收站（非硬删除）；r1 不受影响。
        assert_eq!(record_count(&app, "r2"), 0);
        let items = list_trash_items_internal(&handle).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(
            items[0]["original_path"],
            serde_json::json!(dead.to_string_lossy().to_string())
        );
        let trash_id = items[0]["id"].as_str().unwrap().to_string();

        let outcome = restore_trash_item_internal(&handle, &trash_id).unwrap();
        assert!(matches!(outcome, RestoreOutcome::MetadataOnly));
        assert_eq!(record_count(&app, "r2"), 1);
        assert_eq!(record_count(&app, "r1"), 1);
    }

    // 回归（真实事故 2026-09-29）：删除 → 恢复后列表整体加载失败。
    // 根因：回插把 NULL 数值列写成空文本，列表按数值读取整批报错。
    // 回归契约：删除 → 全部恢复 → 资源列表必须成功返回全部记录。
    #[test]
    fn restore_then_resource_list_succeeds() {
        let (app, library) = trash_test_app();
        let handle = app.handle().clone();
        let group_dir = library.join("组");
        std::fs::create_dir_all(&group_dir).unwrap();
        for index in 0..3 {
            let file = group_dir.join(format!("f{index}.png"));
            std::fs::write(&file, b"png").unwrap();
            insert_external_record(&app, &format!("r{index}"), &file, &[]);
        }
        let ids: Vec<String> = (0..3).map(|index| format!("r{index}")).collect();
        delete_clipboard_records_internal(&handle, &ids).unwrap();

        let items = list_trash_items_internal(&handle).unwrap();
        assert_eq!(items.len(), 3);
        for item in &items {
            restore_trash_item_internal(&handle, item["id"].as_str().unwrap()).unwrap();
        }

        let records = get_clipboard_records_inner(
            &handle,
            None,
            Some(200),
            Some(0),
            Some("resources".to_string()),
            None,
            None,
        )
        .unwrap();
        assert_eq!(records.len(), 3);
    }

    // 兜底闭环 3：同名文件重新入库自动"复活"回收站里的原记录——重新
    // 收集的内容回到原记录（分组/备注保留），不产生孤儿重复行。
    #[test]
    fn discovery_revives_trash_record_for_readded_same_named_file() {
        let (app, library) = trash_test_app();
        let handle = app.handle().clone();
        let group_dir = library.join("组");
        std::fs::create_dir_all(&group_dir).unwrap();
        let alive = group_dir.join("存活.png");
        std::fs::write(&alive, b"1").unwrap();
        insert_external_record(&app, "r1", &alive, &[]);
        let file = group_dir.join("丢失.png");
        std::fs::write(&file, b"png").unwrap();
        insert_external_record(&app, "r2", &file, &[]);
        std::fs::remove_file(&file).unwrap();
        // 库内仍有存活文件（扫描非空），对账才会执行清退。
        sync_resource_library(&handle);
        assert_eq!(record_count(&app, "r2"), 0);
        assert_eq!(record_count(&app, "r1"), 1);

        // 同名文件在别的分组重新入库 → 原记录自动复活并指向新位置。
        let readded = library.join("新位置").join("丢失.png");
        std::fs::create_dir_all(readded.parent().unwrap()).unwrap();
        std::fs::write(&readded, b"png2").unwrap();
        discover_external_resource_files(&handle, &[readded.clone()]);

        assert_eq!(record_count(&app, "r2"), 1);
        // 锁不可重入：每次查询独立持锁，避免与 list_trash_items_internal 互等。
        let stored: String = {
            let state = app.state::<DbState>();
            let conn = state.conn.lock().unwrap();
            conn.query_row(
                "SELECT resource_path FROM clipboard_records WHERE id = 'r2'",
                [],
                |row| row.get(0),
            )
            .unwrap()
        };
        assert_eq!(Path::new(&stored), readded.as_path());
        assert!(list_trash_items_internal(&handle).unwrap().is_empty());
        let dupes: i64 = {
            let state = app.state::<DbState>();
            let conn = state.conn.lock().unwrap();
            conn.query_row(
                "SELECT COUNT(*) FROM clipboard_records WHERE resource_path = ?1",
                params![readded.to_string_lossy().to_string()],
                |row| row.get(0),
            )
            .unwrap()
        };
        assert_eq!(dupes, 1);
    }

    // 兜底根基：回收站在库外——删除后即使整个资源库文件夹被外部清空，
    // 恢复仍能把文件原样放回资源库（历史事故：回收站在库内被连带删除）。
    #[test]
    fn restore_works_even_after_library_folder_wiped_externally() {
        let (app, library) = trash_test_app();
        let handle = app.handle().clone();
        let group_dir = library.join("组");
        std::fs::create_dir_all(&group_dir).unwrap();
        let file = group_dir.join("证件照.png");
        std::fs::write(&file, PNG_BYTES).unwrap();
        insert_external_record(&app, "r1", &file, &[]);

        delete_clipboard_records_internal(&handle, &["r1".to_string()]).unwrap();
        assert!(!file.exists());

        // 模拟用户在文件管理器中清空整个资源库文件夹。
        for entry in std::fs::read_dir(&library).unwrap().flatten() {
            let path = entry.path();
            if path.is_dir() {
                std::fs::remove_dir_all(&path).unwrap();
            } else {
                std::fs::remove_file(&path).unwrap();
            }
        }

        let items = list_trash_items_internal(&handle).unwrap();
        assert_eq!(items.len(), 1);
        let outcome =
            restore_trash_item_internal(&handle, items[0]["id"].as_str().unwrap()).unwrap();
        assert!(matches!(outcome, RestoreOutcome::Restored));
        assert!(file.exists());
        assert_eq!(std::fs::read(&file).unwrap(), PNG_BYTES);
        // 组目录一并恢复，记录回到原分组。
        assert!(group_dir.exists());
    }

    // 启动迁移：历史版本放在库内 .trash 的文件改送系统回收站（fake），
    // 旧回收记录无需任何处理即可继续恢复。
    #[test]
    fn legacy_library_trash_migrates_out_of_library() {
        let (app, library) = trash_test_app();
        let handle = app.handle().clone();
        let group_dir = library.join("组");
        std::fs::create_dir_all(&group_dir).unwrap();
        let file = group_dir.join("迁移.png");
        // 真实历史场景：原位文件已删除（所以副本躺在桶里），原位必须为空，
        // 迁移才能「先回位再送入」并让系统回收站记录到正确的原始路径。

        // 历史形态：记录在回收站，文件位于库内 .trash/<子目录>/。
        let sub = format!(
            "{}-{}",
            chrono::Utc::now().timestamp_millis(),
            uuid::Uuid::new_v4().simple()
        );
        let legacy_file = library.join(".trash").join(&sub).join("迁移.png");
        std::fs::create_dir_all(legacy_file.parent().unwrap()).unwrap();
        std::fs::write(&legacy_file, PNG_BYTES).unwrap();
        {
            let record_json = serde_json::json!({
                "id": "r1",
                "type": "file",
                "content": file.to_string_lossy(),
                "created_at": "2026-09-19T00:00:00Z",
                "group_name": "组",
                "storage_mode": "resource",
                "resource_path": file.to_string_lossy(),
                "resource_external": 1,
                "attachments": "[]",
            });
            let state = app.state::<DbState>();
            let conn = state.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO trash_items
                 (id, record_id, record_json, file_name, original_group, original_path, trash_dir, trashed_at, trashed_ms)
                 VALUES ('t1', 'r1', ?1, '迁移.png', '组', ?2, ?3, '2026-09-29T00:00:00Z', 0)",
                params![
                    record_json.to_string(),
                    file.to_string_lossy().as_ref(),
                    format!(".trash/{sub}"),
                ],
            )
            .unwrap();
        }

        crate::db::migrate_trash_out_of_library(&handle);

        // 库内 .trash 已清空；文件改送系统回收站（fake），且迁移是先回位
        // 再送入——系统回收站记录的原始路径与条目一致，恢复匹配才成立。
        assert!(
            !library.join(".trash").exists()
                || std::fs::read_dir(library.join(".trash"))
                    .unwrap()
                    .next()
                    .is_none()
        );
        assert_eq!(
            fake_count(&file),
            1,
            "迁移后文件应在系统回收站（fake）且原始路径为库内原位"
        );

        // 旧回收记录无需处理即可恢复：文件原样回原位。
        let items = list_trash_items_internal(&handle).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["has_file"], serde_json::Value::Bool(true));
        let outcome =
            restore_trash_item_internal(&handle, items[0]["id"].as_str().unwrap()).unwrap();
        assert!(matches!(outcome, RestoreOutcome::Restored));
        assert!(file.exists());
        assert_eq!(std::fs::read(&file).unwrap(), PNG_BYTES);
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
        assert_eq!(fake_count(&file), 0, "彻底删除应连系统回收站内条目一并清除");
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

    // 换库后恢复：删除后用户切换了资源库，.trash 留在旧库根——恢复按
    // 多根查找定位回收目录（与 purge 同一口径），文件仍能移回原位。
    // 回归锚点：恢复曾只在当前库根找 .trash，换库后文件滞留旧库无法取回。
    #[test]
    fn restore_locates_trash_dir_in_previous_library_root() {
        let (app, library_a) = trash_test_app();
        let handle = app.handle().clone();
        let group_dir = library_a.join("组");
        std::fs::create_dir_all(&group_dir).unwrap();
        let file = group_dir.join("跨库.txt");
        std::fs::write(&file, b"cross").unwrap();
        insert_external_record(&app, "r1", &file, &[]);

        delete_clipboard_records_internal(&handle, &["r1".to_string()]).unwrap();
        assert!(!file.exists());

        // 模拟 set_resource_library_path 的切换链路：当前根改写为新库，
        // 旧库进历史（resource_library_history）。
        let library_b = std::env::temp_dir().join(format!(
            "copy-creator-trash-switch-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&library_b).unwrap();
        {
            let state = app.state::<DbState>();
            let conn = state.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO settings (key, value) VALUES ('resource_library_path', ?1)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![library_b.to_string_lossy().as_ref()],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO settings (key, value) VALUES ('resource_library_history', ?1)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![serde_json::to_string(&vec![library_a.to_string_lossy().to_string()])
                    .unwrap()],
            )
            .unwrap();
        }

        let trash_id = list_trash_items_internal(&handle).unwrap()[0]["id"]
            .as_str()
            .unwrap()
            .to_string();
        restore_trash_item_internal(&handle, &trash_id).unwrap();

        assert!(file.exists(), "恢复应从历史库根找到回收目录并移回文件");
        assert_eq!(std::fs::read(&file).unwrap(), b"cross");
        assert_eq!(record_count(&app, "r1"), 1);
        assert!(list_trash_items_internal(&handle).unwrap().is_empty());
        std::fs::remove_dir_all(&library_b).ok();
    }
    // 删除入回收站后监听结算不得把已删除路径当外部变更重新裁决。回归
    // 锚点：is_ignored_resource_dir 曾只排除 .copy-creator/thumbs，删除
    // 资源的瞬间 watcher 结算会误处理；文件现已移入系统回收站（fake，
    // 库外），结算看到的是原路径消失——必须按删除进行中守卫跳过。
    #[test]
    fn settle_after_trash_does_not_rediscover_trashed_files() {
        assert!(
            crate::db::is_ignored_resource_dir(std::ffi::OsStr::new(".trash")),
            ".trash 必须在应用自身目录忽略规则内（历史桶遗留兼容）"
        );

        let (app, library) = trash_test_app();
        let handle = app.handle().clone();
        let group_dir = library.join("组");
        std::fs::create_dir_all(&group_dir).unwrap();
        let file = group_dir.join("报告.pdf");
        std::fs::write(&file, b"pdf").unwrap();
        insert_external_record(&app, "r1", &file, &[]);

        delete_clipboard_records_internal(&handle, &["r1".to_string()]).unwrap();
        assert_eq!(fake_count(&file), 1);

        // 模拟 watcher 防抖结束后的结算：源路径已消失（守卫应跳过）。
        crate::db::settle_external_resource_changes(&handle, &[file.clone()]);

        // 锁不可重入：计数与列表查询各自独立持锁（同 record_count 纪律）。
        let count: i64 = {
            let state = app.state::<DbState>();
            let conn = state.conn.lock().unwrap();
            conn.query_row("SELECT COUNT(*) FROM clipboard_records", [], |row| row.get(0))
                .unwrap()
        };
        assert_eq!(count, 0, "删除后结算不得重建任何记录");
        assert_eq!(
            list_trash_items_internal(&handle).unwrap().len(),
            1,
            "结算不得对删除进行中的路径重复归档"
        );
    }

    // 同名改指（Relinked）时，resource-file 形态 id 必须随路径级联改写
    // ——否则 id 与 resource_path 脱节（真实事故：记录 id 指旧目录、文件
    // 在新位置，以 id 提取路径的删除暂存永远错位）。
    #[test]
    fn relink_rewrites_resource_file_id_to_match_new_path() {
        let (app, library) = trash_test_app();
        let handle = app.handle().clone();
        let file = library.join("改指.png");
        std::fs::write(&file, b"x").unwrap();
        let record_id = resource_file_id(&file);
        insert_external_record(&app, &record_id, &file, &[]);

        // 对账转存空壳（无桶）后同名文件出现在别处：恢复必然走 Relinked。
        {
            let state = app.state::<DbState>();
            let conn = state.conn.lock().unwrap();
            archive_resource_record_to_trash(&conn, &library, &record_id, &file.to_string_lossy())
                .unwrap();
        }
        std::fs::remove_file(&file).unwrap();
        let moved_dir = library.join("别处");
        std::fs::create_dir_all(&moved_dir).unwrap();
        let moved = moved_dir.join("改指.png");
        std::fs::write(&moved, b"x").unwrap();

        let trash_id = list_trash_items_internal(&handle).unwrap()[0]["id"]
            .as_str()
            .unwrap()
            .to_string();
        let outcome = restore_trash_item_internal(&handle, &trash_id).unwrap();
        assert!(matches!(outcome, RestoreOutcome::Relinked));

        let state = app.state::<DbState>();
        // 断言全部走同一把锁内完成：conn 是不可重入 Mutex，持锁期间不得
        // 再调用会重新加锁的辅助函数（如 record_count）。
        let (row_id, row_path, old_rows_left) = {
            let conn = state.conn.lock().unwrap();
            let row: (String, String) = conn
                .query_row(
                    "SELECT id, resource_path FROM clipboard_records WHERE storage_mode = 'resource'",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .unwrap();
            let old_rows: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM clipboard_records WHERE id = ?1",
                    params![record_id],
                    |row| row.get(0),
                )
                .unwrap();
            (row.0, row.1, old_rows)
        };
        assert_eq!(row_id, resource_file_id(&moved), "id 必须随改指路径级联改写");
        assert_eq!(row_path, moved.to_string_lossy().to_string());
        assert_eq!(old_rows_left, 0, "旧 id 不得残留任何行");
    }

    // 带病库自愈：版本号已前滚但列缺失（真实事故——迁移被启动瞬间锁
    // 冲突打断且静默失败，user_version=2 而 resource_missing 缺列，资源
    // 列表整体加载失败）。ensure_schema 必须以磁盘现状为准补齐列。
    #[test]
    fn ensure_schema_heals_missing_column_with_advanced_version() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        // 手工建 v1 形态的表（无 resource_missing）并把版本号直接写成 2：
        // 模拟迁移版本前滚但 ALTER 实际失败的带病库。
        conn.execute_batch(
            "CREATE TABLE clipboard_records (
                 id TEXT PRIMARY KEY,
                 type TEXT NOT NULL,
                 content TEXT NOT NULL,
                 created_at TEXT NOT NULL,
                 pinned INTEGER NOT NULL DEFAULT 0
             );
             PRAGMA user_version = 2;",
        )
        .unwrap();
        ensure_schema(&conn).unwrap();
        let has_column = conn
            .prepare("PRAGMA table_info(clipboard_records)")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(1))
            .unwrap()
            .flatten()
            .any(|name| name == "resource_missing");
        assert!(has_column, "带病库必须被自愈补齐 resource_missing 列");
    }

    // 删除中注册表的 Windows 路径形态匹配：注册与查询两侧经 watch_path_key
    // 键化后，反斜杠形态与 `\\?\` verbatim 前缀形态必须命中同一键——否则
    // Windows 上删除互斥失效，监听清退竞态防线只在 Linux 生效。
    #[test]
    fn delete_in_flight_keys_match_for_windows_style_paths() {
        use crate::db::resource::{delete_in_flight_contains, register_delete_in_flight, watch_path_key};
        use std::path::Path;
        let path = Path::new(r"C:\Users\w\图片\资源库\a.png");
        let _guard = register_delete_in_flight(vec![path.to_path_buf()]);

        assert!(
            delete_in_flight_contains(&watch_path_key(std::path::Path::new(
                r"C:\Users\w\图片\资源库\a.png"
            ))),
            "同形态路径必须命中"
        );
        assert!(
            delete_in_flight_contains(&watch_path_key(std::path::Path::new(
                r"\\?\C:\Users\w\图片\资源库\a.png"
            ))),
            "verbatim 前缀形态必须被还原后命中"
        );
        assert!(
            !delete_in_flight_contains(&watch_path_key(std::path::Path::new(
                r"C:\Users\w\图片\资源库\b.png"
            ))),
            "不同文件不得误命中"
        );
    }

    // 启动纠偏：历史错位行（id 与 resource_path 不一致的 resource-file
    // 形态）在 ensure_schema 时以 resource_path 为准对齐 id，外键标签表
    // 随同改指。
    #[test]
    fn ensure_schema_realigns_misaligned_resource_file_ids() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        // 模拟历史错位库：id 指旧目录、resource_path 指新位置。
        conn.execute_batch(
            "CREATE TABLE clipboard_records (
                 id TEXT PRIMARY KEY, type TEXT NOT NULL, content TEXT NOT NULL,
                 created_at TEXT NOT NULL, storage_mode TEXT DEFAULT 'database',
                 resource_path TEXT DEFAULT '', pinned INTEGER NOT NULL DEFAULT 0
             );
             CREATE TABLE api_key_labels (
                 record_id TEXT PRIMARY KEY, key_preview TEXT NOT NULL,
                 service TEXT NOT NULL, created_at TEXT NOT NULL
             );
             INSERT INTO clipboard_records (id, type, content, created_at, storage_mode, resource_path)
             VALUES ('resource-file:/old/错位.png', 'file', '/new/错位.png',
                     '2026-01-01T00:00:00Z', 'resource', '/new/错位.png');
             INSERT INTO api_key_labels (record_id, key_preview, service, created_at)
             VALUES ('resource-file:/old/错位.png', 'sk-x', 'OpenAI', '2026-01-01T00:00:00Z');",
        )
        .unwrap();

        ensure_schema(&conn).unwrap();

        let id: String = conn
            .query_row("SELECT id FROM clipboard_records", [], |row| row.get(0))
            .unwrap();
        assert_eq!(id, "resource-file:/new/错位.png", "主表 id 必须对齐 resource_path");
        let label_id: String = conn
            .query_row("SELECT record_id FROM api_key_labels", [], |row| row.get(0))
            .unwrap();
        assert_eq!(label_id, "resource-file:/new/错位.png", "标签表必须随同改指");
    }

    // 对账持久化缺失标志：文件不在扫描集的记录 resource_missing=1——
    // 安全阀中止清退时记录留在列表，但「文件缺失」必须当天可见，不得
    // 静默；文件在的保持 0。
    #[test]
    fn sync_persists_missing_flags_even_when_safety_valve_aborts() {
        let (app, library) = trash_test_app();
        let group_dir = library.join("组");
        std::fs::create_dir_all(&group_dir).unwrap();
        let alive = group_dir.join("在.png");
        std::fs::write(&alive, b"a").unwrap();
        insert_external_record(&app, "r1", &alive, &[]);
        for index in 0..12 {
            let gone = group_dir.join(format!("丢{index}.png"));
            insert_external_record(&app, &format!("m{index}"), &gone, &[]);
        }

        sync_resource_library(app.handle());

        // 安全阀触发（拟清退 12/13 ≥10 且过半）：记录全部保留、不转存，
        // 缺失标志已持久化。
        let state = app.state::<DbState>();
        let flag = {
            let conn = state.conn.lock().unwrap();
            let count: i64 = conn
                .query_row("SELECT COUNT(*) FROM clipboard_records", [], |row| row.get(0))
                .unwrap();
            assert_eq!(count, 13, "安全阀应中止清退，记录全部保留");
            let query_flag = |conn: &rusqlite::Connection, id: &str| -> i64 {
                conn.query_row(
                    "SELECT COALESCE(resource_missing, 0) FROM clipboard_records WHERE id = ?1",
                    params![id],
                    |row| row.get(0),
                )
                .unwrap()
            };
            (
                query_flag(&conn, "r1"),
                query_flag(&conn, "m0"),
                // 锁内不得再调会加锁的内部函数（conn 是不可重入 Mutex）。
                {
                    drop(conn);
                    list_trash_items_internal(&app.handle()).unwrap()
                },
            )
        };
        let (r1_flag, m0_flag, items) = flag;
        assert_eq!(r1_flag, 0, "文件在的记录不得标缺失");
        assert_eq!(m0_flag, 1, "文件缺失的记录必须标缺失");
        assert!(items.is_empty(), "安全阀中止时不得转存回收站");
    }

    // 恢复 Restored 后缺失标志清零：record_json 带回的是入桶前的旧值，
    // 文件实际回位后不得继续显示「文件缺失」。
    #[test]
    fn restore_clears_missing_flag_when_file_back() {
        let (app, library) = trash_test_app();
        let handle = app.handle().clone();
        let file = library.join("回位.png");
        std::fs::write(&file, b"back").unwrap();
        insert_external_record(&app, "r1", &file, &[]);
        {
            let state = app.state::<DbState>();
            let conn = state.conn.lock().unwrap();
            conn.execute(
                "UPDATE clipboard_records SET resource_missing = 1 WHERE id = 'r1'",
                [],
            )
            .unwrap();
        }

        delete_clipboard_records_internal(&handle, &["r1".to_string()]).unwrap();
        let trash_id = list_trash_items_internal(&handle).unwrap()[0]["id"]
            .as_str()
            .unwrap()
            .to_string();
        restore_trash_item_internal(&handle, &trash_id).unwrap();

        let state = app.state::<DbState>();
        let conn = state.conn.lock().unwrap();
        let flag: i64 = conn
            .query_row(
                "SELECT COALESCE(resource_missing, 0) FROM clipboard_records WHERE id = 'r1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(flag, 0, "文件已回位，缺失标志必须清零");
    }

    // 回收站条目实体状态如实反映：文件在桶 → has_file=true；对账转存的
    // 占位条目（无桶）→ has_file=false。前端据此标注「文件已丢失」。
    #[test]
    fn trash_item_reports_file_presence() {
        let (app, library) = trash_test_app();
        let handle = app.handle().clone();

        // 实体条目：文件正常入桶。
        let file = library.join("实体.png");
        std::fs::write(&file, b"data").unwrap();
        insert_external_record(&app, "r1", &file, &[]);
        delete_clipboard_records_internal(&handle, &["r1".to_string()]).unwrap();

        // 占位条目：对账转存，文件本已不在。
        let ghost = library.join("幽灵.png");
        insert_external_record(&app, "r2", &ghost, &[]);
        {
            let state = app.state::<DbState>();
            let conn = state.conn.lock().unwrap();
            archive_resource_record_to_trash(&conn, &library, "r2", &ghost.to_string_lossy())
                .unwrap();
        }

        let items = list_trash_items_internal(&handle).unwrap();
        assert_eq!(items.len(), 2);
        let by_name = |name: &str| {
            items
                .iter()
                .find(|item| item["file_name"] == serde_json::json!(name))
                .unwrap()
        };
        assert_eq!(by_name("实体.png")["has_file"], serde_json::Value::Bool(true));
        assert_eq!(
            by_name("幽灵.png")["has_file"],
            serde_json::Value::Bool(false)
        );
    }

    // 删除结果如实统计：文件在删除之前就已不在磁盘的条目计入
    // files_already_missing，前端得以即时告知「仅删除了记录」，而非等
    // 恢复时才报丢失。
    #[test]
    fn delete_summary_counts_files_already_missing() {
        let (app, library) = trash_test_app();
        let handle = app.handle().clone();
        let present = library.join("存在.png");
        std::fs::write(&present, b"here").unwrap();
        insert_external_record(&app, "r1", &present, &[]);
        let missing_path = library.join("已丢.png");
        insert_external_record(&app, "r2", &missing_path, &[]);

        let summary = delete_clipboard_records_internal(
            &handle,
            &["r1".to_string(), "r2".to_string()],
        )
        .unwrap();
        assert_eq!(summary.deleted, 2);
        assert_eq!(summary.files_already_missing, 1);
    }

    // 本方案最大收益的钉子：用户在资源管理器里删除文件（进系统回收站）
    // → 对账清退转存占位条目 → 占位条目按原始路径从系统回收站找回文件
    // 真实恢复。此前的占位条目只能 metadata_only，恢复按钮直接禁用。
    #[test]
    fn external_delete_placeholder_restorable_via_system_bin() {
        let (app, library) = trash_test_app();
        let handle = app.handle().clone();
        let group_dir = library.join("组");
        std::fs::create_dir_all(&group_dir).unwrap();
        let alive = group_dir.join("存活.png");
        std::fs::write(&alive, b"1").unwrap();
        insert_external_record(&app, "r1", &alive, &[]);
        let file = group_dir.join("外部删除.png");
        std::fs::write(&file, b"explorer-deleted").unwrap();
        insert_external_record(&app, "r2", &file, &[]);

        // 资源管理器删除：文件进系统回收站（fake），应用侧只剩记录。
        fake_send(&file);
        assert!(!file.exists());

        // 对账：文件消失 → 记录转存占位条目；系统回收站内有文件 →
        // has_file 如实为 true（前端恢复按钮可点）。
        sync_resource_library(&handle);
        assert_eq!(record_count(&app, "r2"), 0);
        assert_eq!(record_count(&app, "r1"), 1);
        let items = list_trash_items_internal(&handle).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["has_file"], serde_json::Value::Bool(true));
        let trash_id = items[0]["id"].as_str().unwrap().to_string();

        let outcome = restore_trash_item_internal(&handle, &trash_id).unwrap();
        assert!(matches!(outcome, RestoreOutcome::Restored));
        assert!(file.exists(), "文件应从系统回收站恢复回原位");
        assert_eq!(std::fs::read(&file).unwrap(), b"explorer-deleted");
        assert_eq!(record_count(&app, "r2"), 1);
        assert!(list_trash_items_internal(&handle).unwrap().is_empty());
    }

    // 删除进行中的路径（事务已提交、文件尚未移入系统回收站的窗口形态），
    // 监听结算必须双向跳过：不清退（守卫原语义）、也不补录（文件仍存在
    // 会被当外部新文件重建记录，丢元数据——暂存机制移除后由 existing
    // 分支的守卫兜住）。
    #[test]
    fn settle_skips_paths_registered_as_deleting() {
        let (app, library) = trash_test_app();
        let handle = app.handle().clone();
        let group_dir = library.join("组");
        std::fs::create_dir_all(&group_dir).unwrap();
        let file = group_dir.join("进行中.png");
        std::fs::write(&file, b"busy").unwrap();
        let record_id = resource_file_id(&file);
        insert_external_record(&app, &record_id, &file, &[]);

        // 窗口形态：文件仍在原位（未 send），守卫已注册。
        let guard = register_delete_in_flight(vec![file.clone()]);
        settle_external_resource_changes(&handle, &[file.clone()]);
        drop(guard);

        assert_eq!(
            record_count(&app, &record_id),
            1,
            "在册路径的记录不得被监听清退"
        );
        // 关键断言：existing 分支被守卫跳过，文件不得被补录成重复记录。
        let dupes: i64 = {
            let state = app.state::<DbState>();
            let conn = state.conn.lock().unwrap();
            conn.query_row(
                "SELECT COUNT(*) FROM clipboard_records WHERE resource_path = ?1",
                params![file.to_string_lossy().as_ref()],
                |row| row.get(0),
            )
            .unwrap()
        };
        assert_eq!(dupes, 1, "在册路径的文件不得被补录成重复记录");
        assert!(list_trash_items_internal(&handle).unwrap().is_empty());
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

    /// 回收站条目随迁移保留（0.4.0 起 trash_items 入迁移清单）；源库是
    /// 0.3.x 旧库（无该表）时跳过该表，迁移整体仍成功。回归锚点：曾因
    /// 清单缺 trash_items 导致迁移后回收站被静默清空；补表后又因缺表
    /// 跳过缺失，旧库迁移直接报"没有共同列"失败。
    #[test]
    fn migrates_trash_items_and_tolerates_missing_source_table() {
        let base = std::env::temp_dir().join(format!(
            "copy-creator-migrate-trash-{}",
            uuid::Uuid::new_v4()
        ));
        let old_dir = base.join("old");
        let new_dir = base.join("new");
        std::fs::create_dir_all(&new_dir).unwrap();
        let old_db = seed_old_library(&old_dir);
        {
            let conn = Connection::open(&old_db).unwrap();
            conn.execute(
                "INSERT INTO trash_items (id, record_json, trash_dir, trashed_at, trashed_ms)
                 VALUES ('t1', '{}', '.trash/1-x', '2026-09-18T00:00:00Z', 1)",
                [],
            )
            .unwrap();
        }

        let new_conn = migrate_storage_data(&old_db, &old_dir, &new_dir).unwrap();
        let trash_count: i64 = new_conn
            .query_row("SELECT COUNT(*) FROM trash_items", [], |row| row.get(0))
            .unwrap();
        assert_eq!(trash_count, 1, "回收站条目应随迁移保留");
        drop(new_conn);

        let old_dir2 = base.join("old2");
        std::fs::create_dir_all(&old_dir2).unwrap();
        let old_db2 = seed_old_library(&old_dir2);
        {
            let conn = Connection::open(&old_db2).unwrap();
            conn.execute("DROP TABLE trash_items", []).unwrap();
        }
        let new_conn2 = migrate_storage_data(&old_db2, &old_dir2, &base.join("new2")).unwrap();
        let record_count: i64 = new_conn2
            .query_row("SELECT COUNT(*) FROM clipboard_records", [], |row| row.get(0))
            .unwrap();
        assert_eq!(record_count, 1, "缺表跳过后其余业务数据照常迁移");

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

/// 跨平台语义用例：用 `PathBuf::join` 构造各平台原生分隔符路径，避免
/// 上面 Windows 形态字面量在 Linux 下退化为整段组件导致断言失真。
/// （managed_path_tests 仅 Windows 编译，安全边界的 Linux 语义此前无覆盖。）
#[cfg(test)]
mod managed_path_cross_platform_tests {
    use crate::db::path_within_any;
    use std::path::{Path, PathBuf};

    fn roots() -> Vec<PathBuf> {
        vec![PathBuf::from("data").join("lib")]
    }

    #[test]
    fn native_separated_paths_respect_managed_roots() {
        let root = roots();
        let inside = PathBuf::from("data").join("lib").join("images").join("a.png");
        // 前缀相似但目录名不同（"library"/"libx"）不得放行。
        let lookalike = PathBuf::from("data").join("library").join("x.png");
        let prefix_trick = PathBuf::from("data").join("libx").join("y.png");
        assert!(path_within_any(&inside, &root));
        assert!(!path_within_any(&lookalike, &root));
        assert!(!path_within_any(&prefix_trick, &root));
        assert!(!path_within_any(Path::new(""), &root));
        // 注意：`..` 组件的防穿越在 is_app_managed_path 入口层拒绝，
        // 不属于本纯函数的合同（其组件比较会忽略非 Normal 组件）。
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


#[cfg(test)]
mod clipboard_prune_count_cap_tests {
    use crate::db::{prune_old_records, DbState};
    use rusqlite::Connection;
    use std::sync::Mutex;
    use tauri::Manager;

    // 精简夹具：仅 prune_old_records 触及的表；created_ms 与生产 schema
    // 同式的 VIRTUAL 生成列（由 created_at 派生）。
    fn prune_app() -> tauri::App<tauri::test::MockRuntime> {
        let app = tauri::test::mock_app();
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             CREATE TABLE clipboard_records (
                 id TEXT PRIMARY KEY,
                 type TEXT NOT NULL,
                 content TEXT NOT NULL,
                 created_at TEXT NOT NULL,
                 attachments TEXT DEFAULT '[]',
                 storage_mode TEXT DEFAULT 'database',
                 pinned INTEGER NOT NULL DEFAULT 0,
                 created_ms INTEGER GENERATED ALWAYS AS (
                     CAST((julianday(created_at) - 2440587.5) * 86400000 AS INTEGER)
                 ) VIRTUAL
             );
             CREATE TABLE trash_items (
                 id TEXT PRIMARY KEY,
                 record_id TEXT DEFAULT '',
                 record_json TEXT NOT NULL,
                 file_name TEXT DEFAULT '',
                 original_group TEXT DEFAULT '',
                 original_path TEXT DEFAULT '',
                 trash_dir TEXT NOT NULL,
                 trashed_at TEXT NOT NULL,
                 trashed_ms INTEGER NOT NULL DEFAULT 0
             );",
        )
        .unwrap();
        app.manage(DbState {
            conn: Mutex::new(conn),
        });
        app
    }

    fn insert_record(app: &tauri::App<tauri::test::MockRuntime>, id: &str, created_at: &str, pinned: bool) {
        let state = app.state::<DbState>();
        let conn = state.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO clipboard_records (id, type, content, created_at, pinned) VALUES (?1, 'text', ?2, ?3, ?4)",
            rusqlite::params![id, id, created_at, pinned as i64],
        )
        .unwrap();
    }

    fn remaining_ids(app: &tauri::App<tauri::test::MockRuntime>) -> Vec<String> {
        let state = app.state::<DbState>();
        let conn = state.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT id FROM clipboard_records ORDER BY created_ms ASC")
            .unwrap();
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap();
        rows.map(|r| r.unwrap()).collect()
    }

    fn set_max_records(app: &tauri::App<tauri::test::MockRuntime>, value: &str) {
        let state = app.state::<DbState>();
        let conn = state.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO settings (key, value) VALUES ('clipboard_max_records', ?1)
             ON CONFLICT(key) DO UPDATE SET value = ?1",
            rusqlite::params![value],
        )
        .unwrap();
    }

    // 相对当前时间的 RFC3339 时间戳：必须落在保留期（默认 1 个月）内，
    // 否则时间清理会先于条数上限把夹具删掉。
    fn minutes_ago_rfc3339(minutes: i64) -> String {
        (chrono::Utc::now() - chrono::Duration::minutes(minutes)).to_rfc3339()
    }

    #[test]
    fn count_cap_keeps_newest_and_never_touches_pinned() {
        let app = prune_app();
        // 五条文本记录，r1 最旧 r5 最新；r1 置顶。
        insert_record(&app, "r1", &minutes_ago_rfc3339(50), true);
        insert_record(&app, "r2", &minutes_ago_rfc3339(40), false);
        insert_record(&app, "r3", &minutes_ago_rfc3339(30), false);
        insert_record(&app, "r4", &minutes_ago_rfc3339(20), false);
        insert_record(&app, "r5", &minutes_ago_rfc3339(10), false);
        set_max_records(&app, "3");

        prune_old_records(app.handle()).unwrap();

        // 上限 3：可删额度 = 5 - 3 = 2，删最旧的两条非置顶（r2/r3）；
        // r1 虽最旧但置顶，永不清理。
        assert_eq!(remaining_ids(&app), vec!["r1", "r4", "r5"]);
    }

    #[test]
    fn count_cap_zero_or_missing_means_unlimited() {
        let app = prune_app();
        for (i, minutes) in [50, 40, 30, 20].iter().enumerate() {
            insert_record(&app, &format!("r{}", i + 1), &minutes_ago_rfc3339(*minutes), false);
        }

        set_max_records(&app, "0");
        prune_old_records(app.handle()).unwrap();
        assert_eq!(remaining_ids(&app).len(), 4);

        // 缺省（无该设置行）同样不限。
        {
            let state = app.state::<DbState>();
            let conn = state.conn.lock().unwrap();
            conn.execute("DELETE FROM settings WHERE key = 'clipboard_max_records'", [])
                .unwrap();
        }
        prune_old_records(app.handle()).unwrap();
        assert_eq!(remaining_ids(&app).len(), 4);
    }

}

#[cfg(test)]
mod clipboard_fts_search_tests {
    use crate::db::{get_clipboard_records_inner, get_resource_groups_inner, DbState};
    use rusqlite::Connection;
    use std::sync::Mutex;
    use tauri::Manager;

    // FTS 夹具：ensure_schema 的最小表集 + ensure_clipboard_fts 建索引，
    // 走与生产一致的触发器同步路径。
    fn fts_app() -> tauri::App<tauri::test::MockRuntime> {
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
                 created_ms INTEGER GENERATED ALWAYS AS (
                     CAST((julianday(created_at) - 2440587.5) * 86400000 AS INTEGER)
                 ) VIRTUAL
             );
             CREATE TABLE trash_items (
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
             );",
        )
        .unwrap();
        super::super::ensure_clipboard_fts(&conn);
        app.manage(DbState {
            conn: Mutex::new(conn),
        });
        app
    }

    fn insert_record(app: &tauri::App<tauri::test::MockRuntime>, id: &str, content: &str) {
        let state = app.state::<DbState>();
        let conn = state.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO clipboard_records (id, type, content, created_at) VALUES (?1, 'text', ?2, '2026-01-01T00:00:00+00:00')",
            rusqlite::params![id, content],
        )
        .unwrap();
    }

    fn search(app: &tauri::App<tauri::test::MockRuntime>, keyword: &str) -> Vec<String> {
        get_clipboard_records_inner(
            app.handle(),
            Some(keyword.to_string()),
            Some(200),
            Some(0),
            None,
            None,
            None,
        )
        .unwrap()
        .into_iter()
        .map(|record| record["id"].as_str().unwrap_or_default().to_string())
        .collect()
    }

    #[test]
    fn trigram_substring_search_matches_case_and_cjk() {
        let app = fts_app();
        insert_record(&app, "r1", "The Quick Brown Fox");
        insert_record(&app, "r2", "读取配置段之前先初始化");
        insert_record(&app, "r3", "unrelated content");

        // ASCII 大小写不敏感的子串（trigram 短语查询）。
        assert_eq!(search(&app, "quick brown"), vec!["r1"]);
        // 中文 ≥3 字子串命中。
        assert_eq!(search(&app, "配置段之前"), vec!["r2"]);

        // 短于 trigram 最小词元（2 字符）回退 LIKE，语义不变。
        assert_eq!(search(&app, "ick"), vec!["r1"]);
        assert_eq!(search(&app, "置段"), vec!["r2"]);
    }

    #[test]
    fn fts_stays_in_sync_with_update_and_delete() {
        let app = fts_app();
        insert_record(&app, "r1", "original searchable text");

        assert_eq!(search(&app, "searchable"), vec!["r1"]);

        // 更新正文：新值命中、旧值不再命中（UPDATE 触发器同步）。
        {
            let state = app.state::<DbState>();
            let conn = state.conn.lock().unwrap();
            conn.execute(
                "UPDATE clipboard_records SET content = 'replaced entirely' WHERE id = 'r1'",
                [],
            )
            .unwrap();
        }
        assert!(search(&app, "searchable").is_empty());
        assert_eq!(search(&app, "replaced entirely"), vec!["r1"]);

        // 删除记录：索引同步清空，不再命中。
        {
            let state = app.state::<DbState>();
            let conn = state.conn.lock().unwrap();
            conn.execute("DELETE FROM clipboard_records WHERE id = 'r1'", []).unwrap();
        }
        assert!(search(&app, "replaced entirely").is_empty());
    }

    #[test]
    fn ensure_clipboard_fts_rebuilds_drifted_index() {
        let app = fts_app();
        insert_record(&app, "r1", "first searchable text");
        insert_record(&app, "r2", "second searchable text");
        assert_eq!(search(&app, "searchable").len(), 2);

        // 模拟漂移：撤掉触发器后绕过同步直接删除索引行（内容表不动），
        // 索引与内容表失配。
        {
            let state = app.state::<DbState>();
            let conn = state.conn.lock().unwrap();
            conn.execute_batch(
                "DROP TRIGGER clipboard_fts_insert;
                 DROP TRIGGER clipboard_fts_delete;
                 DROP TRIGGER clipboard_fts_update;
                 DELETE FROM clipboard_fts
                  WHERE rowid = (SELECT rowid FROM clipboard_records WHERE id = 'r2');",
            )
            .unwrap();
            // 直接执行完整性校验应失败（索引少了一行）。
            assert!(conn
                .execute_batch(
                    "INSERT INTO clipboard_fts(clipboard_fts, rank) VALUES ('integrity-check', 1);"
                )
                .is_err());
        }

        // 重跑 ensure_clipboard_fts：integrity-check 失败触发全量重建，
        // 重建触发器后索引恢复一致。
        {
            let state = app.state::<DbState>();
            let conn = state.conn.lock().unwrap();
            super::super::ensure_clipboard_fts(&conn);
        }
        assert_eq!(search(&app, "searchable").len(), 2);
    }

    #[test]
    fn double_quote_in_keyword_falls_back_without_error() {
        let app = fts_app();
        insert_record(&app, "r1", "say \"hello\" loudly");

        // 含双引号的关键词经转义后走 FTS 仍能命中。
        assert_eq!(search(&app, "\"hello\""), vec!["r1"]);
    }
}

#[cfg(test)]
mod schema_version_migration_tests {
    use rusqlite::Connection;

    use super::super::{ensure_schema, SCHEMA_VERSION};

    #[test]
    fn fresh_and_legacy_databases_reach_current_schema_version() {
        // 全新库：基线建表 + 迁移一次执行后版本落当前。
        let fresh = Connection::open_in_memory().unwrap();
        ensure_schema(&fresh).unwrap();
        let version: i32 = fresh
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);
        assert!(version > 0);

        // 幂等：当前版本的库再次执行不报错、版本不变。
        ensure_schema(&fresh).unwrap();
        let version_again: i32 = fresh
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version_again, SCHEMA_VERSION);

        // 旧形状库（有表但缺生成列、user_version=0）：升级后补齐并落版本。
        let legacy = Connection::open_in_memory().unwrap();
        legacy
            .execute_batch(
                "CREATE TABLE clipboard_records (
                     id TEXT PRIMARY KEY,
                     type TEXT NOT NULL,
                     content TEXT NOT NULL,
                     created_at TEXT NOT NULL
                 );
                 INSERT INTO clipboard_records (id, type, content, created_at)
                     VALUES ('r1', 'text', '旧数据', '2025-06-01T00:00:00+00:00');",
            )
            .unwrap();
        ensure_schema(&legacy).unwrap();
        // 生成列不出现在 table_info，须用 table_xinfo。
        let has_created_ms: bool = legacy
            .prepare("SELECT COUNT(*) FROM pragma_table_xinfo('clipboard_records') WHERE name = 'created_ms'")
            .unwrap()
            .query_row([], |row| row.get::<_, i64>(0))
            .map(|count| count > 0)
            .unwrap();
        assert!(has_created_ms);
        let legacy_version: i32 = legacy
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(legacy_version, SCHEMA_VERSION);
    }

}

#[cfg(test)]
mod restore_usability_tests {
    use crate::db::{
        delete_clipboard_records_internal, ensure_schema, get_clipboard_records_inner,
        list_trash_items_internal, restore_trash_item_internal, DbState, RestoreOutcome,
    };
    use crate::db::trash_backend::fake_count;
    use rusqlite::params;
    use std::io::{Read, Write};
    use std::path::PathBuf;
    use std::sync::Mutex;
    use tauri::Manager;

    const PNG_BYTES: [u8; 84] = [
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48,
        0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00,
        0x00, 0x1F, 0x15, 0xC4, 0x89, 0x00, 0x00, 0x00, 0x0A, 0x49, 0x44, 0x41, 0x54, 0x78,
        0x9C, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00,
        0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    ];

    // 用户操作全流程（文件级 + 可用性级）：
    // 资源库删除 → 文件进回收站；回收站恢复 → 文件原样回原位；
    // 恢复后媒体 URL 返回 200 且字节与原文件一致（能展示、能使用）。
    #[test]
    fn restore_returns_file_to_usable_state() {
        let app = tauri::test::mock_app();
        let library = std::env::temp_dir().join(format!(
            "copy-creator-restore-usable-{}",
            uuid::Uuid::new_v4()
        ));
        let group_dir = library.join("组");
        std::fs::create_dir_all(&group_dir).unwrap();
        {
            let conn = rusqlite::Connection::open_in_memory().unwrap();
            ensure_schema(&conn).unwrap();
            app.manage(DbState { conn: Mutex::new(conn) });
        }
        {
            let state = app.state::<DbState>();
            let conn = state.conn.lock().unwrap();
            conn.execute(
                "INSERT OR REPLACE INTO settings (key, value) VALUES ('resource_library_path', ?1)",
                params![library.to_string_lossy().as_ref()],
            )
            .unwrap();
        }
        let handle = app.handle().clone();

        let original = group_dir.join("证件照.png");
        std::fs::write(&original, PNG_BYTES).unwrap();
        {
            let state = app.state::<DbState>();
            let conn = state.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO clipboard_records
                 (id, type, content, created_at, group_name, storage_mode, resource_path, resource_external, attachments)
                 VALUES ('r1', 'file', ?1, '2026-09-19T00:00:00Z', '组', 'resource', ?1, 1, '[]')",
                params![original.to_string_lossy().as_ref()],
            )
            .unwrap();
        }

        // ① 资源库删除：文件离开原位、进入系统回收站（fake）。
        delete_clipboard_records_internal(&handle, &["r1".to_string()]).unwrap();
        assert!(!original.exists(), "删除后文件应离开原位");
        assert_eq!(fake_count(&original), 1, "删除后文件必须在系统回收站内");

        // ② 回收站恢复：文件原样回原位。
        let items = list_trash_items_internal(&handle).unwrap();
        assert_eq!(items.len(), 1);
        let outcome =
            restore_trash_item_internal(&handle, items[0]["id"].as_str().unwrap()).unwrap();
        assert!(matches!(outcome, RestoreOutcome::Restored));
        assert!(original.exists(), "恢复后文件必须回到原位");
        assert_eq!(std::fs::read(&original).unwrap(), PNG_BYTES, "恢复后字节必须与原文件一致");
        assert_eq!(fake_count(&original), 0, "系统回收站副本应清位");

        // ③ 恢复后列表正常返回该记录。
        let records = get_clipboard_records_inner(
            &handle,
            None,
            Some(200),
            Some(0),
            Some("resources".to_string()),
            None,
            None,
        )
        .unwrap();
        assert_eq!(records.len(), 1);

        // ④ 恢复后媒体 URL 可用：真实 HTTP 请求返回 200 + 原始字节
        //    （与前端 <img> 加载同一链路：令牌/白名单/路径解析/流式响应）。
        crate::media_server::spawn(&handle);
        let state = handle.state::<crate::media_server::MediaServerState>();
        let origin = state.origin.clone();
        let token = state.token.clone();
        drop(state);
        let encode = |value: &str| -> String {
            let mut out = String::new();
            for byte in value.as_bytes() {
                match byte {
                    b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => {
                        out.push(*byte as char)
                    }
                    other => out.push_str(&format!("%{other:02X}")),
                }
            }
            out
        };
        let target = format!(
            "/media?token={}&path={}",
            encode(&token),
            encode(original.to_string_lossy().as_ref())
        );
        let address = origin.trim_start_matches("http://");
        let mut stream = std::net::TcpStream::connect(address).unwrap();
        let request = format!(
            "GET {target} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n"
        );
        stream.write_all(request.as_bytes()).unwrap();
        let mut raw = Vec::new();
        stream.read_to_end(&mut raw).unwrap();
        let split = raw
            .windows(4)
            .position(|w| w == b"\r\n\r\n")
            .expect("响应缺少头部结束标记");
        let head = String::from_utf8_lossy(&raw[..split]).to_string();
        let body = raw[split + 4..].to_vec();
        assert!(
            head.starts_with("HTTP/1.1 200"),
            "恢复后媒体必须可访问，实际响应: {head}"
        );
        assert!(head.to_lowercase().contains("content-type: image/png"));
        assert_eq!(body, PNG_BYTES, "恢复后媒体字节必须与原文件一致");
        let _ = group_dir;
    }

}

// ==================== IPC 载荷命名契约 ====================
// Tauri 只自动转换命令入参（camelCase→snake_case），返回值命名完全由
// serde 属性决定——漏声明 rename_all 会把蛇形键直达前端，前端按驼峰
// 读取得到 undefined，渲染中一抛错就是整页卸载（真实事故：清理缺失
// 对话框）。本测试把每个跨 IPC 的结构体载荷键集显式钉住：
// - 标注 [camel] 的必须带 #[serde(rename_all = "camelCase")]，前端按驼峰读；
// - 标注 [snake] 的历史载荷两端均为蛇形；
// 新增/修改任一端命名的唯一通路是同步更新本测试（= 强制过评审）。
// json! 字面量键不受 rename_all 影响，键即契约，新增时请在此登记同类断言。
#[cfg(test)]
mod ipc_naming_contract_tests {
    use crate::autostart::AutostartStatus;
    use crate::backup::BackupManifest;
    use crate::db::annotation::ResourceAnnotation;
    use crate::db::clipboard::DeleteRecordsSummary;
    use crate::db::phrase::ResourceTextPreview;
    use crate::db::resource::{MissingResourceEntry, RecheckMissingSummary};
    use crate::db::trash::{RestoreBatchSummary, RestoreOutcome};
    use crate::paste::PasteBackendStatus;

    fn keys_of<T: serde::Serialize>(value: &T) -> Vec<String> {
        let mut keys: Vec<String> = serde_json::to_value(value)
            .unwrap()
            .as_object()
            .expect("IPC 载荷必须是对象")
            .keys()
            .cloned()
            .collect();
        keys.sort();
        keys
    }

    fn assert_keys<T: serde::Serialize>(value: &T, expected: &[&str]) {
        let mut expected: Vec<String> = expected.iter().map(|k| k.to_string()).collect();
        expected.sort();
        assert_eq!(keys_of(value), expected);
    }

    #[test]
    fn camel_case_payloads_serialize_with_camel_keys() {
        // [camel] 删除统计（消费方：ResourcePage 删除反馈）
        assert_keys(
            &DeleteRecordsSummary { deleted: 1, files_already_missing: 2 },
            &["deleted", "filesAlreadyMissing"],
        );
        // [camel] 缺失重查（消费方：清理确认对话框；字段错位曾致整页消失）
        assert_keys(
            &RecheckMissingSummary {
                library_accessible: true,
                recovered: 1,
                total_resources: 2,
                still_missing: vec![MissingResourceEntry { id: "m".into(), name: "a.mp4".into() }],
            },
            &["libraryAccessible", "recovered", "stillMissing", "totalResources"],
        );
        // [camel] 粘贴环境诊断（消费方：PasteEnvironmentSection）
        assert_keys(
            &PasteBackendStatus {
                session: "x11",
                ydotool_installed: true,
                ydotoold_installed: true,
                ydotoold_running: true,
                wtype_installed: false,
                xdotool_installed: true,
            },
            &["session", "ydotoolInstalled", "ydotooldInstalled", "ydotooldRunning", "wtypeInstalled", "xdotoolInstalled"],
        );
    }

    #[test]
    fn snake_case_payloads_keep_snake_keys() {
        // [snake] 回收站批量恢复统计（消费方：TrashPanel）
        assert_keys(
            &RestoreBatchSummary { restored: 1, relinked: 2, metadata_only: 3, failed: vec![] },
            &["restored", "relinked", "metadata_only", "failed"],
        );
        // [snake] 恢复结果枚举值本身也是契约（TrashPanel 按字符串比较）
        assert_eq!(
            serde_json::to_value(RestoreOutcome::MetadataOnly).unwrap(),
            serde_json::json!("metadata_only")
        );
        // [snake] 资源标注（消费方：domain/annotations.ts 按 raw.start_offset 取）
        assert_keys(
            &ResourceAnnotation {
                id: "a".into(),
                record_id: "r".into(),
                start_offset: 0,
                length: 1,
                kind: "bold".into(),
                anchor_text: "x".into(),
                created_at: "now".into(),
            },
            &["id", "record_id", "start_offset", "length", "kind", "anchor_text", "created_at"],
        );
        // [snake] 开机自启状态（消费方：App.tsx）
        assert_keys(
            &AutostartStatus { enabled: false, file_exists: false, path_correct: false, message: String::new() },
            &["enabled", "file_exists", "path_correct", "message"],
        );
        // [snake] 备份清单（文件格式 + 设置页展示，双契约）
        assert_keys(
            &BackupManifest {
                format_version: 1,
                app_version: "0.0.0".into(),
                exported_at: "now".into(),
                includes_library: true,
                library_path: String::new(),
                table_counts: Default::default(),
            },
            &["format_version", "app_version", "exported_at", "includes_library", "library_path", "table_counts"],
        );
        // [snake] 资源文本预览（消费方：ResourceDetailPage）
        assert_keys(
            &ResourceTextPreview { content: String::new(), truncated: false },
            &["content", "truncated"],
        );
    }
}

#[cfg(test)]
mod text_version_tests {
    use crate::db::{
        add_text_version, clear_resource_text_versions_inner, list_resource_text_versions_inner,
        record_versions_after_write, restore_resource_text_version_inner,
        top_text_version_content, write_text_content_inner,
        DbState, simplify_windows_path, VERSION_SOURCE_EDIT, VERSION_SOURCE_EXTERNAL,
        VERSION_SOURCE_INIT, VERSION_SOURCE_RESTORE,
    };
    use rusqlite::{params, Connection};
    use std::path::PathBuf;
    use std::sync::Mutex;
    use tauri::Manager;

    /// 本地完整夹具:临时库目录 + settings 指向 + 内存业务库
    /// (trash/resource_command 测试同款;业务表为最小 schema,版本表由
    /// 测试体按 ensure_schema 同构补建)。
    fn history_test_app() -> (tauri::App<tauri::test::MockRuntime>, PathBuf) {
        let app = tauri::test::mock_app();
        let root = std::env::temp_dir().join(format!(
            "copy-creator-text-version-test-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let root = crate::db::simplify_windows_path(&root.canonicalize().unwrap());
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             CREATE TABLE clipboard_records (
                 id TEXT PRIMARY KEY,
                 type TEXT NOT NULL,
                 content TEXT NOT NULL,
                 created_at TEXT NOT NULL,
                 storage_mode TEXT DEFAULT 'database',
                 resource_path TEXT DEFAULT ''
             );",
        )
        .unwrap();
        conn.execute(
            "INSERT INTO settings (key, value) VALUES ('resource_library_path', ?1)",
            params![root.to_string_lossy().as_ref()],
        )
        .unwrap();
        app.manage(DbState {
            conn: Mutex::new(conn),
        });
        (app, root)
    }

    /// 内存库 + 与 ensure_schema 同构的版本表（外键级联开启）。
    fn version_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "PRAGMA foreign_keys=ON;
             CREATE TABLE clipboard_records (
                 id TEXT PRIMARY KEY,
                 type TEXT NOT NULL,
                 content TEXT NOT NULL,
                 created_at TEXT NOT NULL,
                 storage_mode TEXT DEFAULT 'database',
                 resource_path TEXT DEFAULT ''
             );
             CREATE TABLE resource_text_versions (
                 id TEXT PRIMARY KEY,
                 record_id TEXT NOT NULL,
                 content TEXT NOT NULL,
                 byte_size INTEGER NOT NULL,
                 source TEXT NOT NULL,
                 created_at TEXT NOT NULL,
                 FOREIGN KEY (record_id) REFERENCES clipboard_records(id)
                     ON DELETE CASCADE ON UPDATE CASCADE
             );",
        )
        .unwrap();
        conn.execute(
            "INSERT INTO clipboard_records (id, type, content, created_at, storage_mode)
             VALUES ('rec-1', 'file', 'p.txt', '2026-01-01', 'resource')",
            [],
        )
        .unwrap();
        conn
    }

    fn version_sources(conn: &Connection, record_id: &str) -> Vec<(String, String)> {
        let mut stmt = conn
            .prepare(
                "SELECT source, content FROM resource_text_versions
                 WHERE record_id = ?1 ORDER BY rowid DESC",
            )
            .unwrap();
        stmt.query_map(params![record_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap()
    }

    // 保存落盘记版：版本链为空时先把入库原文补为首版「首次入库」，再记
    // 本次写入「应用内编辑」；新内容与顶端相同（空转保存）不重复记。
    #[test]
    fn write_seeds_init_then_edit_and_skips_same_content() {
        let conn = version_db();
        record_versions_after_write(&conn, "rec-1", Some("v1"), "v2\n", VERSION_SOURCE_EDIT)
            .unwrap();
        assert_eq!(
            version_sources(&conn, "rec-1"),
            vec![
                (VERSION_SOURCE_EDIT.to_string(), "v2\n".to_string()),
                (VERSION_SOURCE_INIT.to_string(), "v1".to_string()),
            ]
        );
        // 空转保存：与顶端内容相同不记。
        record_versions_after_write(&conn, "rec-1", Some("v2\n"), "v2\n", VERSION_SOURCE_EDIT)
            .unwrap();
        assert_eq!(version_sources(&conn, "rec-1").len(), 2);
        // 文件原本缺失（prior None）：只记本次内容，不补 init。
        let conn2 = version_db();
        record_versions_after_write(&conn2, "rec-1", None, "fresh\n", VERSION_SOURCE_EDIT)
            .unwrap();
        assert_eq!(version_sources(&conn2, "rec-1").len(), 1);
    }

    // 限量淘汰：每条资源最多 20 版，超出按写入顺序淘汰最旧。
    #[test]
    fn version_limit_prunes_oldest() {
        let conn = version_db();
        for i in 0..22 {
            add_text_version(&conn, "rec-1", &format!("v{i}\n"), VERSION_SOURCE_EDIT).unwrap();
        }
        let sources = version_sources(&conn, "rec-1");
        assert_eq!(sources.len(), 20);
        assert_eq!(sources[0].1, "v21\n"); // 最新保留
        assert_eq!(sources[19].1, "v2\n"); // v0、v1 已淘汰
    }

    // 外键双向级联：删记录版本随删、id 改写版本随迁（与标注同模型）。
    #[test]
    fn foreign_key_cascades_delete_and_id_rewrite() {
        let conn = version_db();
        add_text_version(&conn, "rec-1", "v1\n", VERSION_SOURCE_INIT).unwrap();
        conn.execute("UPDATE clipboard_records SET id = 'rec-2' WHERE id = 'rec-1'", [])
            .unwrap();
        assert_eq!(version_sources(&conn, "rec-2").len(), 1);
        conn.execute("DELETE FROM clipboard_records WHERE id = 'rec-2'", []).unwrap();
        assert_eq!(version_sources(&conn, "rec-2").len(), 0);
    }

    // 保存 → 还原 → 外部修改懒对齐的完整回路（走真实文件与命令层）。
    #[test]
    fn save_restore_and_external_lazy_align_round_trip() {
        let (app, root) = history_test_app();
        let handle = app.handle().clone();
        let file: PathBuf = root.join("改动记录.txt");
        std::fs::write(&file, "v1").unwrap();
        {
            let state = app.state::<DbState>();
            let conn = state.conn.lock().unwrap();
            conn.execute_batch(
                "CREATE TABLE resource_text_versions (
                     id TEXT PRIMARY KEY,
                     record_id TEXT NOT NULL,
                     content TEXT NOT NULL,
                     byte_size INTEGER NOT NULL,
                     source TEXT NOT NULL,
                     created_at TEXT NOT NULL,
                     FOREIGN KEY (record_id) REFERENCES clipboard_records(id)
                         ON DELETE CASCADE ON UPDATE CASCADE
                 );",
            )
            .unwrap();
            conn.execute(
                "INSERT INTO clipboard_records (id, type, content, created_at, storage_mode, resource_path)
                 VALUES ('rec-1', 'file', ?1, '2026-01-01', 'resource', ?1)",
                params![file.to_string_lossy().as_ref()],
            )
            .unwrap();
        }
        let path = file.to_string_lossy().to_string();

        // 应用内保存：文件更新为规范化内容，版本链 = [edit, init]。
        let saved = write_text_content_inner(&handle, &path, " v2 ", Some("rec-1".into()), VERSION_SOURCE_EDIT)
            .unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "v2\n");
        assert_eq!(saved["record_type"], "file");
        let versions = list_resource_text_versions_inner(&handle, "rec-1", &path).unwrap();
        assert_eq!(versions.len(), 2);
        assert_eq!(versions[0].source, VERSION_SOURCE_EDIT);
        assert_eq!(versions[1].source, VERSION_SOURCE_INIT);
        let init_id = versions[1].id.clone();

        // 还原到入库版：文件原样写回「v1」（无规范化补换行），并记一版
        // 「还原」；紧接的懒对齐发现文件与顶端一致，不再误记外部修改。
        restore_resource_text_version_inner(&handle, &init_id).unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "v1");
        let versions = list_resource_text_versions_inner(&handle, "rec-1", &path).unwrap();
        assert_eq!(versions.len(), 3);
        assert_eq!(versions[0].source, VERSION_SOURCE_RESTORE);
        let again = list_resource_text_versions_inner(&handle, "rec-1", &path).unwrap();
        assert_eq!(again.len(), 3);

        // 外部程序改文件：下次列表读取懒对齐补记「外部修改」。
        std::fs::write(&file, "hacked").unwrap();
        let versions = list_resource_text_versions_inner(&handle, "rec-1", &path).unwrap();
        assert_eq!(versions.len(), 4);
        assert_eq!(versions[0].source, VERSION_SOURCE_EXTERNAL);

        // 还原到「外部修改」版后文件内容随之更新；顶端内容查询与链一致。
        let external_id = versions[0].id.clone();
        restore_resource_text_version_inner(&handle, &external_id).unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "hacked");
        {
            let state = app.state::<DbState>();
            let conn = state.conn.lock().unwrap();
            assert_eq!(
                top_text_version_content(&conn, "rec-1").unwrap().unwrap(),
                "hacked"
            );
        }
        // 还原到「外部修改」版后文件内容随之更新；内容与顶端相同，
        // 记版被同内容去重跳过（重复还原同一目标不产生噪音版本），
        // 链仍是 4 版。clear inner 内部会获取 DB 锁，不得在持有 guard
        // 的块内调用（否则自锁死——实测挂死定位的教训）。
        let removed = clear_resource_text_versions_inner(&handle, "rec-1").unwrap();
        assert_eq!(removed, 4);
        {
            let state = app.state::<DbState>();
            let conn = state.conn.lock().unwrap();
            assert_eq!(top_text_version_content(&conn, "rec-1").unwrap(), None);
        }
    }

    // 外部发现的记录（resource_external=1，资源库扫描入库而非应用内新建）
    // 在应用内保存同样记版：记版按 record_id 走、与记录来源无关；归一
    // UPDATE 对已是文件承载形态的外部记录是幂等空操作（type/content 原样）。
    #[test]
    fn external_record_save_records_versions_and_keeps_row() {
        let (app, root) = history_test_app();
        let handle = app.handle().clone();
        let file: PathBuf = root.join("外部资源.txt");
        std::fs::write(&file, "v1").unwrap();
        {
            let state = app.state::<DbState>();
            let conn = state.conn.lock().unwrap();
            conn.execute_batch(
                "ALTER TABLE clipboard_records ADD COLUMN resource_external INTEGER DEFAULT 0;
                 CREATE TABLE resource_text_versions (
                     id TEXT PRIMARY KEY,
                     record_id TEXT NOT NULL,
                     content TEXT NOT NULL,
                     byte_size INTEGER NOT NULL,
                     source TEXT NOT NULL,
                     created_at TEXT NOT NULL,
                     FOREIGN KEY (record_id) REFERENCES clipboard_records(id)
                         ON DELETE CASCADE ON UPDATE CASCADE
                 );",
            )
            .unwrap();
            conn.execute(
                "INSERT INTO clipboard_records
                     (id, type, content, created_at, storage_mode, resource_path, resource_external)
                 VALUES ('rec-ext', 'file', ?1, '2026-01-01', 'resource', ?1, 1)",
                params![file.to_string_lossy().as_ref()],
            )
            .unwrap();
        }
        let path = file.to_string_lossy().to_string();

        write_text_content_inner(&handle, &path, " v2 ", Some("rec-ext".into()), VERSION_SOURCE_EDIT)
            .unwrap();
        let versions = list_resource_text_versions_inner(&handle, "rec-ext", &path).unwrap();
        assert_eq!(versions.len(), 2);
        assert_eq!(versions[0].source, VERSION_SOURCE_EDIT);
        assert_eq!(versions[1].source, VERSION_SOURCE_INIT);
        {
            let state = app.state::<DbState>();
            let conn = state.conn.lock().unwrap();
            let (rtype, content): (String, String) = conn
                .query_row(
                    "SELECT type, content FROM clipboard_records WHERE id = 'rec-ext'",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .unwrap();
            assert_eq!(rtype, "file");
            assert_eq!(content, path);
        }
    }
}

// ── 工程域（AI 视频制作）：schema、级联、档案 upsert 与迁移登记 ──
#[cfg(test)]
mod project_tests {
    use crate::db::{ensure_schema, Connection, MIGRATED_BUSINESS_TABLES, PROJECT_SCHEMA_SQL};
    use rusqlite::params;

    fn project_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        conn.execute_batch(PROJECT_SCHEMA_SQL).unwrap();
        conn
    }

    fn count(conn: &Connection, sql: &str) -> i64 {
        conn.query_row(sql, [], |row| row.get(0)).unwrap()
    }

    #[test]
    fn schema_creates_all_project_tables() {
        let conn = project_conn();
        for table in [
            "project_shows",
            "project_episodes",
            "project_characters",
            "project_locations",
            "project_props",
            "project_scenes",
            "project_shots",
            "project_assets",
            "project_prompts",
            "project_episode_characters",
            "project_shot_characters",
            "project_shot_props",
        ] {
            let exists: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                    [table],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(exists, 1, "缺表：{table}");
        }
    }

    #[test]
    fn ensure_schema_main_path_also_creates_project_tables() {
        // 工程表经 ensure_schema 主路径建库（init_db / 存储迁移共用），
        // 防止 PROJECT_SCHEMA_SQL 忘挂在主入口。
        let conn = Connection::open_in_memory().unwrap();
        ensure_schema(&conn).unwrap();
        let exists: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'project_shots'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(exists, 1);
    }

    #[test]
    fn hierarchy_cascades_on_show_delete() {
        let conn = project_conn();
        conn.execute(
            "INSERT INTO project_shows (id, name, note, created_at, updated_at) VALUES ('s1', '山海食肆', '', '2026-01-01', '2026-01-01')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO project_episodes (id, show_id, number, title, status, script_path, sort_order, created_at, updated_at) \
             VALUES ('e1', 's1', 1, '开业大吉', 'done', '', 0, '2026-01-01', '2026-01-01')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO project_characters (id, name, role_tag, bio, prompt, avatar_path, created_at, updated_at) \
             VALUES ('c1', '陆离', '掌柜', '', '', '', '2026-01-01', '2026-01-01')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO project_episode_characters (episode_id, character_id) VALUES ('e1', 'c1')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO project_scenes (id, episode_id, location_id, heading, sort_order, note, created_at, updated_at) \
             VALUES ('sc1', 'e1', '', '场 1', 0, '', '2026-01-01', '2026-01-01')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO project_shots (id, scene_id, episode_id, description, dialogue, sort_order, created_at, updated_at) \
             VALUES ('sh1', 'sc1', 'e1', '特写', '', 0, '2026-01-01', '2026-01-01')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO project_shot_characters (shot_id, character_id) VALUES ('sh1', 'c1')",
            [],
        )
        .unwrap();

        conn.execute("DELETE FROM project_shows WHERE id = 's1'", [])
            .unwrap();
        for (label, sql) in [
            ("集", "SELECT COUNT(*) FROM project_episodes"),
            ("场景", "SELECT COUNT(*) FROM project_scenes"),
            ("镜头", "SELECT COUNT(*) FROM project_shots"),
            (
                "集-角色关联",
                "SELECT COUNT(*) FROM project_episode_characters",
            ),
            (
                "镜头-角色关联",
                "SELECT COUNT(*) FROM project_shot_characters",
            ),
        ] {
            assert_eq!(count(&conn, sql), 0, "删剧后{label}应级联清空");
        }
        // 角色是全局实体：删剧不影响角色库。
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM project_characters"), 1);
    }

    #[test]
    fn shot_delete_keeps_asset_as_loose() {
        let conn = project_conn();
        conn.execute(
            "INSERT INTO project_shows (id, name, note, created_at, updated_at) VALUES ('s1', 'x', '', '2026-01-01', '2026-01-01')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO project_episodes (id, show_id, number, title, status, script_path, sort_order, created_at, updated_at) \
             VALUES ('e1', 's1', 1, '', 'none', '', 0, '2026-01-01', '2026-01-01')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO project_scenes (id, episode_id, location_id, heading, sort_order, note, created_at, updated_at) \
             VALUES ('sc1', 'e1', '', '', 0, '', '2026-01-01', '2026-01-01')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO project_shots (id, scene_id, episode_id, description, dialogue, sort_order, created_at, updated_at) \
             VALUES ('sh1', 'sc1', 'e1', '', '', 0, '2026-01-01', '2026-01-01')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO project_assets (id, file_path, kind, name, shot_id, episode_id, gen_from_asset, gen_from_prompt, created_at, updated_at) \
             VALUES ('a1', '第 2 集/分镜/S1-01.png', 'image', 'S1-01', 'sh1', 'e1', '', '', '2026-01-01', '2026-01-01')",
            [],
        )
        .unwrap();

        // 删镜头：素材档案保留、降级为集级散件（shot_id 置空），文件不动。
        // shot_id/episode_id 是软引用，降级由命令层显式 UPDATE（见
        // detach_assets_before_delete），这里按命令的完整顺序验证。
        crate::db::detach_assets_before_delete(
            &conn,
            "UPDATE project_assets SET shot_id = '', updated_at = ?1 WHERE shot_id = ?2",
            "sh1",
        )
        .unwrap();
        conn.execute("DELETE FROM project_shots WHERE id = 'sh1'", [])
            .unwrap();
        let (shot_id, episode_id): (String, String) = conn
            .query_row(
                "SELECT shot_id, episode_id FROM project_assets WHERE id = 'a1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(shot_id, "");
        assert_eq!(episode_id, "e1");
    }

    #[test]
    fn link_asset_upsert_moves_ownership() {
        let conn = project_conn();
        // 模拟 project_link_asset 的 upsert：同一文件二次挂靠改写归属。
        for (shot_id, episode_id) in [("sh1", "e1"), ("", "e2")] {
            conn.execute(
                "INSERT INTO project_assets (id, file_path, kind, name, shot_id, episode_id, gen_from_asset, gen_from_prompt, created_at, updated_at) \
                 VALUES ('a-x', '组/S1-01.png', 'image', 'S1-01', ?1, ?2, '', '', '2026-01-01', '2026-01-01') \
                 ON CONFLICT(file_path) DO UPDATE SET shot_id = excluded.shot_id, episode_id = excluded.episode_id, updated_at = excluded.updated_at",
                [shot_id, episode_id],
            )
            .unwrap();
        }
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM project_assets"), 1);
        let (shot_id, episode_id): (String, String) = conn
            .query_row(
                "SELECT shot_id, episode_id FROM project_assets WHERE file_path = '组/S1-01.png'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!((shot_id.as_str(), episode_id.as_str()), ("", "e2"));
    }

    #[test]
    fn replace_links_full_swap() {
        let conn = project_conn();
        conn.execute(
            "INSERT INTO project_shows (id, name, note, created_at, updated_at) VALUES ('s1', 'x', '', '2026-01-01', '2026-01-01')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO project_episodes (id, show_id, number, title, status, script_path, sort_order, created_at, updated_at)
             VALUES ('e1', 's1', 1, '', 'none', '', 0, '2026-01-01', '2026-01-01')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO project_characters (id, name, role_tag, bio, prompt, avatar_path, created_at, updated_at) \
             VALUES ('c1', '甲', '', '', '', '', '2026-01-01', '2026-01-01')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO project_characters (id, name, role_tag, bio, prompt, avatar_path, created_at, updated_at) \
             VALUES ('c2', '乙', '', '', '', '', '2026-01-01', '2026-01-01')",
            [],
        )
        .unwrap();
        for (episode_id, character_id) in [("e1", "c1"), ("e1", "c2")] {
            conn.execute(
                "INSERT OR IGNORE INTO project_episode_characters (episode_id, character_id) VALUES (?1, ?2)",
                [episode_id, character_id],
            )
            .unwrap();
        }
        // 整组替换为只剩 c2：DELETE + 重插（模拟 replace_links）。
        conn.execute(
            "DELETE FROM project_episode_characters WHERE episode_id = 'e1'",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT OR IGNORE INTO project_episode_characters (episode_id, character_id) VALUES ('e1', 'c2')",
            [],
        )
        .unwrap();
        let ids: Vec<String> = conn
            .prepare("SELECT character_id FROM project_episode_characters WHERE episode_id = 'e1'")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(ids, vec!["c2".to_string()]);
    }

    #[test]
    fn character_delete_clears_links_but_keeps_episodes() {
        let conn = project_conn();
        conn.execute(
            "INSERT INTO project_characters (id, name, role_tag, bio, prompt, avatar_path, created_at, updated_at) \
             VALUES ('c1', '甲', '', '', '', '', '2026-01-01', '2026-01-01')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO project_shows (id, name, note, created_at, updated_at) VALUES ('s1', 'x', '', '2026-01-01', '2026-01-01')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO project_episodes (id, show_id, number, title, status, script_path, sort_order, created_at, updated_at) \
             VALUES ('e1', 's1', 1, '', 'none', '', 0, '2026-01-01', '2026-01-01')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO project_episode_characters (episode_id, character_id) VALUES ('e1', 'c1')",
            [],
        )
        .unwrap();
        conn.execute("DELETE FROM project_characters WHERE id = 'c1'", [])
            .unwrap();
        assert_eq!(
            count(&conn, "SELECT COUNT(*) FROM project_episode_characters"),
            0
        );
        assert_eq!(
            count(&conn, "SELECT COUNT(*) FROM project_episodes"),
            1,
            "删全局角色不应影响集本身"
        );
    }

    #[test]
    fn consistency_columns_added_idempotently() {
        // 旧库升级：建表语句无新列时 ensure_column 补齐；再跑一遍不报错。
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        conn.execute_batch(
            "CREATE TABLE project_characters (
                id TEXT PRIMARY KEY, name TEXT NOT NULL, role_tag TEXT NOT NULL DEFAULT '',
                bio TEXT NOT NULL DEFAULT '', prompt TEXT NOT NULL DEFAULT '',
                avatar_path TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
            );
            CREATE TABLE project_shots (
                id TEXT PRIMARY KEY, scene_id TEXT NOT NULL, episode_id TEXT NOT NULL,
                description TEXT NOT NULL DEFAULT '', dialogue TEXT NOT NULL DEFAULT '',
                sort_order REAL NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
            );
            CREATE TABLE project_assets (
                id TEXT PRIMARY KEY, file_path TEXT NOT NULL UNIQUE, kind TEXT NOT NULL DEFAULT 'file',
                name TEXT NOT NULL DEFAULT '', shot_id TEXT NOT NULL DEFAULT '',
                episode_id TEXT NOT NULL DEFAULT '', gen_from_asset TEXT NOT NULL DEFAULT '',
                gen_from_prompt TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
            );",
        )
        .unwrap();
        crate::db::ensure_schema(&conn).unwrap();
        for (table, column) in [
            ("project_characters", "reference_paths"),
            ("project_shots", "status"),
            ("project_shots", "camera"),
            ("project_shots", "duration"),
            ("project_assets", "gen_params"),
            ("project_assets", "audio_role"),
        ] {
            let exists: i64 = conn
                .query_row(
                    &format!(
                        "SELECT COUNT(*) FROM pragma_table_info('{table}') WHERE name = '{column}'"
                    ),
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(exists, 1, "{table}.{column} 应已补齐");
        }
        // 新列可写可读（默认值语义）。
        conn.execute(
            "INSERT INTO project_shots (id, scene_id, episode_id, status, camera, duration, created_at, updated_at) \
             VALUES ('sh1', 'sc', 'e1', 'done', '特写', '8s', '2026-01-01', '2026-01-01')",
            [],
        )
        .unwrap();
        let (status, camera, duration): (String, String, String) = conn
            .query_row(
                "SELECT status, camera, duration FROM project_shots WHERE id = 'sh1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(
            (status.as_str(), camera.as_str(), duration.as_str()),
            ("done", "特写", "8s")
        );
    }

    #[test]
    fn migrated_tables_include_project_schema() {
        // 新表漏登记 MIGRATED_BUSINESS_TABLES 会导致换存储目录丢工程数据；
        // 钉住 11 张表全部在册。
        for table in [
            "project_shows",
            "project_episodes",
            "project_characters",
            "project_locations",
            "project_props",
            "project_scenes",
            "project_shots",
            "project_assets",
            "project_prompts",
            "project_episode_characters",
            "project_shot_characters",
            "project_shot_props",
        ] {
            assert!(
                MIGRATED_BUSINESS_TABLES.contains(&table),
                "{table} 未登记进 MIGRATED_BUSINESS_TABLES"
            );
        }
    }

    #[test]
    fn search_matches_description_fields() {
        // 工程搜索除名称/标题外还应命中描述性正文：角色/道具的 bio
        // （剧的 note 同列机制，提示词正文原本已覆盖）。
        let conn = project_conn();
        conn.execute(
            "INSERT INTO project_characters (id, name, role_tag, bio, prompt, avatar_path, created_at, updated_at) \
             VALUES ('c1', '陆离', '掌柜', '沉默寡言的老江湖', '', '', '2026-01-01', '2026-01-01')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO project_props (id, name, bio, prompt, ref_path, created_at, updated_at) \
             VALUES ('p1', '铜锣', '祖传的老铜锣，声音清亮', '', '', '2026-01-01', '2026-01-01')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO project_characters (id, name, role_tag, bio, prompt, avatar_path, created_at, updated_at) \
             VALUES ('c2', '阿_强', '', '带下划线的名字', '', '', '2026-01-01', '2026-01-01')",
            [],
        )
        .unwrap();
        let hits = crate::db::project::project_search_inner(&conn, "老江湖").unwrap();
        assert!(
            hits.iter()
                .any(|r| r["kind"] == "character" && r["id"] == "c1"),
            "角色 bio 未命中搜索：{hits:?}"
        );
        let hits = crate::db::project::project_search_inner(&conn, "清亮").unwrap();
        assert!(
            hits.iter().any(|r| r["kind"] == "prop" && r["id"] == "p1"),
            "道具 bio 未命中搜索：{hits:?}"
        );
        // LIKE 通配符按字面匹配：搜「阿_」只命中名字含下划线的角色，
        // 下划线不得当成「任意单字符」把「阿强」之类也带进来。
        let hits = crate::db::project::project_search_inner(&conn, "阿_").unwrap();
        assert!(
            hits.iter().any(|r| r["kind"] == "character" && r["id"] == "c2"),
            "通配符转义后应命中字面下划线：{hits:?}"
        );
    }

    #[test]
    fn episode_overview_aggregates_scenes_shots_and_assets() {
        // 集工作台聚合（批量重构后的行为锚点）：多场景多镜头下，
        // 出镜/道具/素材按镜头分组归位，散件单独返回，他集素材不串场。
        let conn = project_conn();
        conn.execute(
            "INSERT INTO project_characters (id, name, role_tag, bio, prompt, avatar_path, created_at, updated_at) \
             VALUES ('c1', '陆离', '掌柜', '', '', '', '2026-01-01', '2026-01-01')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO project_props (id, name, bio, prompt, ref_path, created_at, updated_at) \
             VALUES ('p1', '铜锣', '', '', '', '2026-01-01', '2026-01-01')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO project_locations (id, name, int_ext, time_hint, bio, prompt, ref_path, created_at, updated_at) \
             VALUES ('l1', '客栈大堂', '内景', '夜', '', '', '', '2026-01-01', '2026-01-01')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO project_shows (id, name, note, created_at, updated_at) VALUES ('s1', '剧', '', '2026-01-01', '2026-01-01')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO project_episodes (id, show_id, number, title, status, script_path, sort_order, created_at, updated_at) \
             VALUES ('e1', 's1', 1, '第一集', 'none', '', 0, '2026-01-01', '2026-01-01')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO project_episodes (id, show_id, number, title, status, script_path, sort_order, created_at, updated_at) \
             VALUES ('e2', 's1', 2, '第二集', 'none', '', 1, '2026-01-01', '2026-01-01')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO project_episode_characters (episode_id, character_id) VALUES ('e1', 'c1')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO project_scenes (id, episode_id, location_id, heading, sort_order, note, created_at, updated_at) \
             VALUES ('sc1', 'e1', 'l1', '内 客栈 夜', 0, '', '2026-01-01', '2026-01-01')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO project_scenes (id, episode_id, location_id, heading, sort_order, note, created_at, updated_at) \
             VALUES ('sc2', 'e1', '', '外 山道 晨', 1, '', '2026-01-01', '2026-01-01')",
            [],
        )
        .unwrap();
        for (id, scene_id, order) in [("sh1", "sc1", 0), ("sh2", "sc1", 1), ("sh3", "sc2", 0)] {
            conn.execute(
                "INSERT INTO project_shots (id, scene_id, episode_id, description, dialogue, sort_order, created_at, updated_at) \
                 VALUES (?1, ?2, 'e1', '描述', '', ?3, '2026-01-01', '2026-01-01')",
                params![id, scene_id, order],
            )
            .unwrap();
        }
        conn.execute(
            "INSERT INTO project_shot_characters (shot_id, character_id) VALUES ('sh1', 'c1')",
            [],
        )
        .unwrap();
        conn.execute("INSERT INTO project_shot_props (shot_id, prop_id) VALUES ('sh2', 'p1')", [])
            .unwrap();
        for (id, path, shot_id) in [
            ("a1", "第 1 集/分镜/S1.png", "sh1"),
            ("a2", "第 1 集/分镜/S2.png", "sh2"),
            ("a3", "第 1 集/参考.png", ""),
        ] {
            conn.execute(
                "INSERT INTO project_assets (id, file_path, kind, name, shot_id, episode_id, created_at, updated_at) \
                 VALUES (?1, ?2, 'image', ?2, ?3, 'e1', '2026-01-01', '2026-01-01')",
                params![id, path, shot_id],
            )
            .unwrap();
        }
        // 他集素材：不得出现在 e1 的任何分组里
        conn.execute(
            "INSERT INTO project_assets (id, file_path, kind, name, shot_id, episode_id, created_at, updated_at) \
             VALUES ('a9', '第 2 集/x.png', 'image', 'x.png', '', 'e2', '2026-01-01', '2026-01-01')",
            [],
        )
        .unwrap();

        let overview =
            crate::db::project::episode_overview_inner(&conn, "e1", std::path::Path::new(""))
                .unwrap();
        assert_eq!(overview["characters"].as_array().unwrap().len(), 1);
        let scenes = overview["scenes"].as_array().unwrap();
        assert_eq!(scenes.len(), 2);
        assert_eq!(scenes[0]["location"]["name"], "客栈大堂");
        assert!(scenes[1]["location"].is_null());
        let shots1 = scenes[0]["shots"].as_array().unwrap();
        assert_eq!(shots1.len(), 2);
        assert_eq!(shots1[0]["character_ids"], serde_json::json!(["c1"]));
        assert_eq!(shots1[0]["assets"].as_array().unwrap().len(), 1);
        assert_eq!(shots1[0]["assets"][0]["id"], "a1");
        assert_eq!(shots1[1]["prop_ids"], serde_json::json!(["p1"]));
        let shots2 = scenes[1]["shots"].as_array().unwrap();
        assert_eq!(shots2.len(), 1);
        assert_eq!(shots2[0]["character_ids"], serde_json::json!([]));
        assert_eq!(shots2[0]["assets"].as_array().unwrap().len(), 0);
        let loose = overview["loose_assets"].as_array().unwrap();
        assert_eq!(loose.len(), 1);
        assert_eq!(loose[0]["id"], "a3");
    }

    #[test]
    fn episode_overview_flags_missing_asset_files() {
        // 缺失口径锚点：overview 给每个素材档案带 missing 标记——文件在
        // 库根下存在为 false，不在为 true。库里删文件后工程悬空档案靠它
        // 显形（与资源库「文件缺失」同口径）。
        let conn = project_conn();
        conn.execute(
            "INSERT INTO project_shows (id, name, note, created_at, updated_at) \
             VALUES ('s1', '剧', '', '2026-01-01', '2026-01-01')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO project_episodes (id, show_id, number, title, status, script_path, sort_order, created_at, updated_at) \
             VALUES ('e1', 's1', 1, '', 'none', '', 0, '2026-01-01', '2026-01-01')",
            [],
        )
        .unwrap();
        let root = std::env::temp_dir().join(format!(
            "copy-creator-project-overview-missing-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("ok.png"), b"png").unwrap();
        for (id, path) in [("a1", "ok.png"), ("a2", "分镜/gone.png")] {
            conn.execute(
                "INSERT INTO project_assets (id, file_path, kind, name, shot_id, episode_id, created_at, updated_at) \
                 VALUES (?1, ?2, 'image', ?2, '', 'e1', '2026-01-01', '2026-01-01')",
                params![id, path],
            )
            .unwrap();
        }
        let overview = crate::db::project::episode_overview_inner(&conn, "e1", &root).unwrap();
        let loose = overview["loose_assets"].as_array().unwrap();
        assert_eq!(loose.len(), 2);
        let missing_of = |id: &str| {
            loose
                .iter()
                .find(|asset| asset["id"] == id)
                .unwrap()["missing"]
                .as_bool()
                .unwrap()
        };
        assert!(!missing_of("a1"), "库内存在的文件不应标缺失");
        assert!(missing_of("a2"), "库内不存在的文件应标缺失");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn copy_into_library_root_dedupes_names() {
        // 导入重名约定锚点：无冲突用原名；冲突加「 (1)」序号且不覆盖
        // 已有文件；无扩展名文件同样处理；源文件保留（复制非移动）。
        let root = std::env::temp_dir().join(format!(
            "copy-creator-import-copy-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let outside = std::env::temp_dir().join(format!(
            "copy-creator-import-src-{}.png",
            uuid::Uuid::new_v4()
        ));
        std::fs::write(&outside, b"png-bytes").unwrap();

        // 无冲突：原名落库
        let first = crate::db::project::copy_into_library_root(&root, &outside).unwrap();
        assert_eq!(first.file_name().unwrap().to_string_lossy(), outside.file_name().unwrap().to_string_lossy());
        // 同名再导：加 (1) 序号，两份内容独立
        let second = crate::db::project::copy_into_library_root(&root, &outside).unwrap();
        assert!(second.file_name().unwrap().to_string_lossy().ends_with(" (1).png"));
        assert!(first.exists() && second.exists() && outside.exists(), "复制不得覆盖或移动源文件");

        // 无扩展名文件：序号加在主干后
        let no_ext = std::env::temp_dir().join(format!("noext-{}", uuid::Uuid::new_v4()));
        std::fs::write(&no_ext, b"x").unwrap();
        let placed = crate::db::project::copy_into_library_root(&root, &no_ext).unwrap();
        assert!(!placed.to_string_lossy().contains('.'), "无扩展名文件不应凭空加扩展名");

        std::fs::remove_dir_all(&root).ok();
        std::fs::remove_file(&outside).ok();
        std::fs::remove_file(&no_ext).ok();
    }

    #[test]
    fn canvas_layout_roundtrip() {
        // 画布布局持久化锚点：素材/镜头/场景坐标批量保存后 overview 原样
        // 回读；未摆放的实体坐标为 null（前端据此自动布局，不落默认值）。
        let conn = project_conn();
        conn.execute(
            "INSERT INTO project_shows (id, name, note, created_at, updated_at) \
             VALUES ('s1', '剧', '', '2026-01-01', '2026-01-01')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO project_episodes (id, show_id, number, title, status, script_path, sort_order, created_at, updated_at) \
             VALUES ('e1', 's1', 1, '', 'none', '', 0, '2026-01-01', '2026-01-01')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO project_scenes (id, episode_id, heading, sort_order, created_at, updated_at) \
             VALUES ('sc1', 'e1', '场景', 0, '2026-01-01', '2026-01-01')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO project_shots (id, scene_id, episode_id, description, sort_order, created_at, updated_at) \
             VALUES ('sh1', 'sc1', 'e1', '', 0, '2026-01-01', '2026-01-01')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO project_assets (id, file_path, kind, name, shot_id, episode_id, created_at, updated_at) \
             VALUES ('a1', 'x.png', 'image', 'x.png', '', 'e1', '2026-01-01', '2026-01-01')",
            [],
        )
        .unwrap();
        let root = std::env::temp_dir().join(format!(
            "copy-creator-canvas-layout-{}",
            uuid::Uuid::new_v4()
        ));
        let overview_of = || crate::db::project::episode_overview_inner(&conn, "e1", &root).unwrap();

        let overview = overview_of();
        assert!(overview["scenes"][0]["canvas_x"].is_null(), "未摆放的场景坐标应为 null");
        assert!(overview["scenes"][0]["shots"][0]["canvas_y"].is_null());
        assert!(overview["loose_assets"][0]["canvas_w"].is_null());

        crate::db::project::canvas_layout_inner(
            &conn,
            &serde_json::json!({
                "assets": [{ "id": "a1", "x": 120.0, "y": 80.0, "w": 220.0 }],
                "shots": [{ "id": "sh1", "x": 100.0, "y": 60.0 }],
                "scenes": [{ "id": "sc1", "x": 60.0, "y": 40.0 }]
            }),
        )
        .unwrap();
        let overview = overview_of();
        assert_eq!(overview["scenes"][0]["canvas_x"], 60.0);
        assert_eq!(overview["scenes"][0]["canvas_y"], 40.0);
        assert_eq!(overview["scenes"][0]["shots"][0]["canvas_x"], 100.0);
        assert_eq!(overview["loose_assets"][0]["canvas_x"], 120.0);
        assert_eq!(overview["loose_assets"][0]["canvas_w"], 220.0);
    }

    #[test]
    fn asset_links_lifecycle() {
        // 手动工作流连线锚点：创建（重复幂等）→ overview 返回 → 反方向
        // 摘除；自连与不存在素材被拒绝；删素材后连线随外键级联消失。
        let conn = project_conn();
        conn.execute(
            "INSERT INTO project_shows (id, name, note, created_at, updated_at) \
             VALUES ('s1', '剧', '', '2026-01-01', '2026-01-01')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO project_episodes (id, show_id, number, title, status, script_path, sort_order, created_at, updated_at) \
             VALUES ('e1', 's1', 1, '', 'none', '', 0, '2026-01-01', '2026-01-01')",
            [],
        )
        .unwrap();
        for id in ["a1", "a2"] {
            conn.execute(
                "INSERT INTO project_assets (id, file_path, kind, name, shot_id, episode_id, created_at, updated_at) \
                 VALUES (?1, ?1 || '.png', 'image', ?1, '', 'e1', '2026-01-01', '2026-01-01')",
                params![id],
            )
            .unwrap();
        }
        let root = std::env::temp_dir().join(format!(
            "copy-creator-canvas-links-{}",
            uuid::Uuid::new_v4()
        ));
        let links_of = || {
            crate::db::project::episode_overview_inner(&conn, "e1", &root)
                .unwrap()["links"]
                .as_array()
                .unwrap()
                .len()
        };

        assert!(crate::db::project::link_assets_inner(&conn, "a1", "a1", "参考").is_err(), "自连应被拒绝");
        assert!(
            crate::db::project::link_assets_inner(&conn, "a1", "ghost", "参考").is_err(),
            "不存在的素材应被拒绝"
        );
        crate::db::project::link_assets_inner(&conn, "a1", "a2", "参考").unwrap();
        crate::db::project::link_assets_inner(&conn, "a1", "a2", "参考").unwrap();
        assert_eq!(links_of(), 1, "重复连线应幂等忽略");

        let overview = crate::db::project::episode_overview_inner(&conn, "e1", &root).unwrap();
        assert_eq!(overview["links"][0]["from_asset"], "a1");
        assert_eq!(overview["links"][0]["to_asset"], "a2");
        assert_eq!(overview["links"][0]["label"], "参考");

        // 反方向也能摘除（画布上连线不区分朝向删除）。
        crate::db::project::unlink_assets_inner(&conn, "a2", "a1").unwrap();
        assert_eq!(links_of(), 0);

        crate::db::project::link_assets_inner(&conn, "a1", "a2", "参考").unwrap();
        conn.execute("DELETE FROM project_assets WHERE id = 'a1'", [])
            .unwrap();
        assert_eq!(links_of(), 0, "删素材后连线应随外键级联消失");
    }

    #[test]
    fn episode_output_roundtrip() {
        // 成片输出（每集工作流的总输出）：来源可以是素材或镜头
        // （"shot:<id>"），可清除；来源不存在与空集被拒绝；overview 的
        // episode 节点带出 output_asset_id 供画布渲染成片连线。
        let conn = project_conn();
        conn.execute(
            "INSERT INTO project_shows (id, name, note, created_at, updated_at) \
             VALUES ('s1', '剧', '', '2026-01-01', '2026-01-01')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO project_episodes (id, show_id, number, title, status, script_path, sort_order, created_at, updated_at) \
             VALUES ('e1', 's1', 1, '', 'none', '', 0, '2026-01-01', '2026-01-01')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO project_assets (id, file_path, kind, name, shot_id, episode_id, created_at, updated_at) \
             VALUES ('a1', 'a1.mp4', 'video', 'a1', '', 'e1', '2026-01-01', '2026-01-01')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO project_scenes (id, episode_id, location_id, heading, sort_order, note, created_at, updated_at) \
             VALUES ('sc1', 'e1', '', '场', 0, '', '2026-01-01', '2026-01-01')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO project_shots (id, scene_id, episode_id, description, sort_order, created_at, updated_at) \
             VALUES ('sh1', 'sc1', 'e1', '', 0, '2026-01-01', '2026-01-01')",
            [],
        )
        .unwrap();

        assert!(
            crate::db::project::set_episode_output_inner(&conn, "ghost", Some("a1")).is_err(),
            "集不存在应被拒绝"
        );
        assert!(
            crate::db::project::set_episode_output_inner(&conn, "e1", Some("nope")).is_err(),
            "不存在的素材应被拒绝"
        );
        assert!(
            crate::db::project::set_episode_output_inner(&conn, "e1", Some("shot:ghost")).is_err(),
            "不存在的镜头应被拒绝"
        );

        crate::db::project::set_episode_output_inner(&conn, "e1", Some("a1")).unwrap();
        let overview =
            crate::db::project::episode_overview_inner(&conn, "e1", &std::env::temp_dir()).unwrap();
        assert_eq!(overview["episode"]["output_asset_id"], "a1");

        crate::db::project::set_episode_output_inner(&conn, "e1", Some("shot:sh1")).unwrap();
        let overview =
            crate::db::project::episode_overview_inner(&conn, "e1", &std::env::temp_dir()).unwrap();
        assert_eq!(overview["episode"]["output_asset_id"], "shot:sh1");

        crate::db::project::set_episode_output_inner(&conn, "e1", Some("")).unwrap();
        let overview =
            crate::db::project::episode_overview_inner(&conn, "e1", &std::env::temp_dir()).unwrap();
        assert!(
            overview["episode"]["output_asset_id"].is_null(),
            "空串应清除为 NULL"
        );
    }

    #[test]
    fn segments_and_node_links_lifecycle() {
        // 片段工作流：新建排到序列尾、相邻交换排序、挂产出视频（缺失拒
        // 绝、删素材置空）、输入口连线（未知来源/端口拒绝、剧本要求已挂
        // 接、幂等）；删片段后连线级联消失；overview 带出 segments 与
        // node_links。
        let conn = project_conn();
        conn.execute(
            "INSERT INTO project_shows (id, name, note, created_at, updated_at) \
             VALUES ('s1', '剧', '', '2026-01-01', '2026-01-01')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO project_episodes (id, show_id, number, title, status, script_path, sort_order, created_at, updated_at) \
             VALUES ('e1', 's1', 1, '', 'none', '', 0, '2026-01-01', '2026-01-01')",
            [],
        )
        .unwrap();

        let s1 = crate::db::project::add_segment_inner(&conn, "e1").unwrap();
        let s2 = crate::db::project::add_segment_inner(&conn, "e1").unwrap();
        let s3 = crate::db::project::add_segment_inner(&conn, "e1").unwrap();
        assert!(
            s1["sort_order"].as_f64().unwrap() < s2["sort_order"].as_f64().unwrap()
                && s2["sort_order"].as_f64().unwrap() < s3["sort_order"].as_f64().unwrap(),
            "新建片段应按创建顺序递增拼接序"
        );

        crate::db::project::move_segment_inner(&conn, s3["id"].as_str().unwrap(), -1).unwrap();
        let order_of = |id: &str| {
            conn.query_row(
                "SELECT sort_order FROM project_segments WHERE id = ?1",
                params![id],
                |row| row.get::<_, f64>(0),
            )
            .unwrap()
        };
        assert!(
            order_of(s3["id"].as_str().unwrap()) < order_of(s2["id"].as_str().unwrap()),
            "前移后 s3 应排到 s2 之前"
        );
        assert!(
            crate::db::project::move_segment_inner(&conn, "ghost", -1).is_err(),
            "片段不存在应被拒绝"
        );

        // 产出视频：不存在拒绝；挂上后 overview 带出 asset；删素材置空。
        conn.execute(
            "INSERT INTO project_assets (id, file_path, kind, name, shot_id, episode_id, created_at, updated_at) \
             VALUES ('v1', 'v1.mp4', 'video', 'v1', '', 'e1', '2026-01-01', '2026-01-01')",
            [],
        )
        .unwrap();
        assert!(
            crate::db::project::set_segment_asset_inner(&conn, s1["id"].as_str().unwrap(), Some("nope")).is_err(),
            "不存在的素材应被拒绝"
        );
        crate::db::project::set_segment_asset_inner(&conn, s1["id"].as_str().unwrap(), Some("v1"))
            .unwrap();
        let overview =
            crate::db::project::episode_overview_inner(&conn, "e1", &std::env::temp_dir()).unwrap();
        assert_eq!(overview["segments"].as_array().unwrap().len(), 3);
        assert_eq!(
            overview["segments"][0]["asset"]["id"], "v1",
            "overview 应按拼接序带出片段与其产出素材"
        );

        // 输入口连线：剧本口要求集已挂接剧本；未知端口/来源拒绝；幂等。
        assert!(
            crate::db::project::link_node_inner(&conn, "e1", "script", "e1", s2["id"].as_str().unwrap(), "script", "").is_err(),
            "未挂接剧本时应被拒绝"
        );
        conn.execute(
            "UPDATE project_episodes SET script_path = 'e1.md', updated_at = '2026-01-01' WHERE id = 'e1'",
            [],
        )
        .unwrap();
        crate::db::project::link_node_inner(&conn, "e1", "script", "e1", s2["id"].as_str().unwrap(), "script", "")
            .unwrap();
        crate::db::project::link_node_inner(&conn, "e1", "script", "e1", s2["id"].as_str().unwrap(), "script", "")
            .unwrap();
        // 提示词口（新增）：剧本与提示词同为文本类互相兼容，剧本可接提示词口。
        crate::db::project::link_node_inner(&conn, "e1", "script", "e1", s2["id"].as_str().unwrap(), "prompt", "")
            .unwrap();
        assert!(
            crate::db::project::link_node_inner(&conn, "e1", "ghost", "x", s2["id"].as_str().unwrap(), "other", "").is_err(),
            "未知来源类型应被拒绝"
        );
        assert!(
            crate::db::project::link_node_inner(&conn, "e1", "asset", "v1", s2["id"].as_str().unwrap(), "nonsense", "").is_err(),
            "未知输入口应被拒绝"
        );
        // 片段→片段续生成线（视频进其他口）；镜头产出也可作为片段来源。
        crate::db::project::link_node_inner(&conn, "e1", "segment", s1["id"].as_str().unwrap(), s2["id"].as_str().unwrap(), "other", "")
            .unwrap();
        conn.execute(
            "INSERT INTO project_scenes (id, episode_id, location_id, heading, sort_order, note, created_at, updated_at) \
             VALUES ('sc1', 'e1', '', '场', 0, '', '2026-01-01', '2026-01-01')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO project_shots (id, scene_id, episode_id, description, sort_order, created_at, updated_at) \
             VALUES ('sh1', 'sc1', 'e1', '', 0, '2026-01-01', '2026-01-01')",
            [],
        )
        .unwrap();
        crate::db::project::link_node_inner(&conn, "e1", "shot", "sh1", s2["id"].as_str().unwrap(), "other", "")
            .unwrap();

        let overview =
            crate::db::project::episode_overview_inner(&conn, "e1", &std::env::temp_dir()).unwrap();
        assert_eq!(overview["node_links"].as_array().unwrap().len(), 4, "重复连线应幂等忽略");

        // 删片段后其输入口连线级联消失。
        crate::db::project::remove_segment_inner(&conn, s2["id"].as_str().unwrap()).unwrap();
        let overview =
            crate::db::project::episode_overview_inner(&conn, "e1", &std::env::temp_dir()).unwrap();
        assert_eq!(overview["segments"].as_array().unwrap().len(), 2);
        assert_eq!(overview["node_links"].as_array().unwrap().len(), 0, "片段删除应级联清掉输入口连线");

        // 删产出素材后片段保留、产出置空（ON DELETE SET NULL）。
        conn.execute("DELETE FROM project_assets WHERE id = 'v1'", []).unwrap();
        let overview =
            crate::db::project::episode_overview_inner(&conn, "e1", &std::env::temp_dir()).unwrap();
        assert!(overview["segments"][0]["asset_id"].is_null());
    }

    #[test]
    fn episode_locations_roundtrip() {
        // 本集场景关联（画布场景节点数据源）：整组替换 + overview 带出
        // 完整场景对象与 location_ids。
        let conn = project_conn();
        conn.execute(
            "INSERT INTO project_shows (id, name, note, created_at, updated_at) \
             VALUES ('s1', '剧', '', '2026-01-01', '2026-01-01')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO project_episodes (id, show_id, number, title, status, script_path, sort_order, created_at, updated_at) \
             VALUES ('e1', 's1', 1, '', 'none', '', 0, '2026-01-01', '2026-01-01')",
            [],
        )
        .unwrap();
        for id in ["l1", "l2"] {
            conn.execute(
                "INSERT INTO project_locations (id, name, int_ext, time_hint, bio, prompt, ref_path, created_at, updated_at) \
                 VALUES (?1, ?1, 'INT', 'DAY', '', '', '', '2026-01-01', '2026-01-01')",
                params![id],
            )
            .unwrap();
        }
        conn.execute(
            "INSERT INTO project_episode_locations (episode_id, location_id) VALUES ('e1', 'l1')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO project_episode_locations (episode_id, location_id) VALUES ('e1', 'l2')",
            [],
        )
        .unwrap();
        let overview =
            crate::db::project::episode_overview_inner(&conn, "e1", &std::env::temp_dir()).unwrap();
        assert_eq!(overview["locations"].as_array().unwrap().len(), 2);
        assert_eq!(overview["locations"][0]["id"], "l1");
        assert_eq!(overview["episode"]["location_ids"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn episodes_list_returns_sorted_with_stats() {
        // 剧集树主查询（带参 SQL 的防回归锚点）：按 sort_order 排序
        // （reorder 写的就是它，集号 number 仅作次序兜底），附镜头总数/
        // 完成数与出场角色，无数据的集回落为 0/空。
        let conn = project_conn();
        conn.execute(
            "INSERT INTO project_shows (id, name, note, created_at, updated_at) VALUES ('s1', '剧', '', '2026-01-01', '2026-01-01')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO project_episodes (id, show_id, number, title, status, script_path, sort_order, created_at, updated_at) \
             VALUES ('e2', 's1', 2, '第二集', 'none', '', 3, '2026-01-01', '2026-01-01')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO project_episodes (id, show_id, number, title, status, script_path, sort_order, created_at, updated_at) \
             VALUES ('e1', 's1', 1, '第一集', 'none', '', 5, '2026-01-01', '2026-01-01')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO project_characters (id, name, role_tag, bio, prompt, avatar_path, created_at, updated_at) \
             VALUES ('c1', '陆离', '', '', '', '', '2026-01-01', '2026-01-01')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO project_episode_characters (episode_id, character_id) VALUES ('e1', 'c1')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO project_scenes (id, episode_id, location_id, heading, sort_order, note, created_at, updated_at) \
             VALUES ('sc1', 'e1', '', '内 客栈 夜', 0, '', '2026-01-01', '2026-01-01')",
            [],
        )
        .unwrap();
        for (id, episode_id, status) in [
            ("sh1", "e1", "done"),
            ("sh2", "e1", "pending"),
            ("sh3", "e2", "done"),
        ] {
            conn.execute(
                "INSERT INTO project_shots (id, scene_id, episode_id, description, dialogue, status, sort_order, created_at, updated_at) \
                 VALUES (?1, 'sc1', ?2, '', '', ?3, 0, '2026-01-01', '2026-01-01')",
                params![id, episode_id, status],
            )
            .unwrap();
        }
        // 他剧数据不得串场
        conn.execute(
            "INSERT INTO project_shows (id, name, note, created_at, updated_at) VALUES ('s2', '别的剧', '', '2026-01-01', '2026-01-01')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO project_episodes (id, show_id, number, title, status, script_path, sort_order, created_at, updated_at) \
             VALUES ('e9', 's2', 1, '他剧集', 'none', '', 0, '2026-01-01', '2026-01-01')",
            [],
        )
        .unwrap();

        let episodes = crate::db::project::episodes_list_inner(&conn, "s1").unwrap();
        // sort_order 与集号刻意相反（e2 sort 3 / e1 sort 5）：排序键是
        // sort_order（reorder 所写），集号 number 不参与主序。
        assert_eq!(episodes.len(), 2);
        assert_eq!(episodes[0]["id"], "e2");
        assert_eq!(episodes[1]["id"], "e1");
        assert_eq!(episodes[0]["shot_count"], 1);
        assert_eq!(episodes[0]["done_shot_count"], 1);
        assert_eq!(episodes[0]["character_ids"], serde_json::json!([]));
        assert_eq!(episodes[1]["shot_count"], 2);
        assert_eq!(episodes[1]["done_shot_count"], 1);
        assert_eq!(episodes[1]["character_ids"], serde_json::json!(["c1"]));
    }
}

#[cfg(test)]
mod canvas_tests {
    use crate::db::canvas::{parse_node_meta_lenient, NodeMeta, CANVAS_SCHEMA_SQL};
    use crate::db::{ensure_schema, Connection, MIGRATED_BUSINESS_TABLES};
    use rusqlite::params;

    fn canvas_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        conn.execute_batch(CANVAS_SCHEMA_SQL).unwrap();
        conn
    }

    fn full_conn() -> Connection {
        // 走完整 ensure_schema（主批次 + 工程 + 画布三批次），验证画布
        // 建表在真实启动路径下生效。
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        ensure_schema(&conn).unwrap();
        conn
    }

    fn count(conn: &Connection, sql: &str) -> i64 {
        conn.query_row(sql, [], |row| row.get(0)).unwrap()
    }

    fn count_params(conn: &Connection, sql: &str, p: &[&dyn rusqlite::ToSql]) -> i64 {
        conn.query_row(sql, p, |row| row.get(0)).unwrap()
    }

    #[test]
    fn schema_creates_all_canvas_tables() {
        let conn = canvas_conn();
        for table in ["canvases", "canvas_nodes", "canvas_connections"] {
            let n: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1",
                    params![table],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(n, 1, "{table} 未建表");
        }
    }

    #[test]
    fn ensure_schema_creates_canvas_tables() {
        let conn = full_conn();
        for table in ["canvases", "canvas_nodes", "canvas_connections"] {
            let n: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1",
                    params![table],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(n, 1, "{table} 应随 ensure_schema 建立");
        }
        // canvases 表可查。
        let n: i64 = count(&conn, "SELECT COUNT(*) FROM canvases");
        assert_eq!(n, 0);
    }

    #[test]
    fn migrated_tables_include_canvas_schema() {
        // 新表漏登记 MIGRATED_BUSINESS_TABLES 会导致换存储目录丢画布数据。
        for table in ["canvases", "canvas_nodes", "canvas_connections"] {
            assert!(
                MIGRATED_BUSINESS_TABLES.contains(&table),
                "{table} 未登记进 MIGRATED_BUSINESS_TABLES"
            );
        }
    }

    #[test]
    fn canvas_crud_and_aggregates() {
        let conn = canvas_conn();
        let canvas = crate::db::canvas::create_canvas(&conn, "  测试画布  ").unwrap();
        let canvas_id = canvas["id"].as_str().unwrap();
        assert_eq!(canvas["name"], "测试画布");

        // 空名建画布给默认名。
        let unnamed = crate::db::canvas::create_canvas(&conn, "   ").unwrap();
        assert_eq!(unnamed["name"], "未命名画布");

        crate::db::canvas::rename_canvas(&conn, canvas_id, "改名后").unwrap();
        assert!(crate::db::canvas::rename_canvas(&conn, canvas_id, "  ").is_err());

        // 四类节点：未传 metadata 用默认值。
        let text = crate::db::canvas::create_node(
            &conn, canvas_id, "text", "提示词", 10.0, 20.0, Some(200.0), Some(120.0), "", "",
        )
        .unwrap();
        let image = crate::db::canvas::create_node(
            &conn, canvas_id, "image", "生图", 300.0, 20.0, None, None, "", "",
        )
        .unwrap();
        let refn = crate::db::canvas::create_node(
            &conn, canvas_id, "ref", "参考图", 10.0, 200.0, None, None, "assets/foo.png", "",
        )
        .unwrap();
        let note = crate::db::canvas::create_node(
            &conn, canvas_id, "note", "", 300.0, 200.0, None, None, "", "",
        )
        .unwrap();
        assert_eq!(text["metadata"]["kind"], "text");
        assert_eq!(image["metadata"]["kind"], "image");
        assert_eq!(image["metadata"]["status"], "idle");
        assert_eq!(image["metadata"]["params"]["count"], 1);
        assert_eq!(refn["metadata"]["kind"], "ref");
        assert_eq!(refn["resource_path"], "assets/foo.png");
        assert_eq!(note["metadata"]["kind"], "note");
        assert_eq!(text["width"], 200.0);
        assert!(image["width"].is_null());

        let text_id = text["id"].as_str().unwrap();
        let image_id = image["id"].as_str().unwrap();
        let ref_id = refn["id"].as_str().unwrap();
        let note_id = note["id"].as_str().unwrap();

        // 多入线：两个上游连同一目标都成立（v2 连线语义）。
        let w1 = crate::db::canvas::connect(&conn, canvas_id, text_id, image_id).unwrap();
        crate::db::canvas::connect(&conn, canvas_id, ref_id, image_id).unwrap();
        assert_eq!(
            count_params(
                &conn,
                "SELECT COUNT(*) FROM canvas_connections WHERE canvas_id = ?1",
                &[&canvas_id]
            ),
            2
        );

        // 同源重复：INSERT OR IGNORE 去重，返回既有行。
        let dup = crate::db::canvas::connect(&conn, canvas_id, text_id, image_id).unwrap();
        assert_eq!(dup["id"], w1["id"]);
        assert_eq!(
            count_params(
                &conn,
                "SELECT COUNT(*) FROM canvas_connections WHERE canvas_id = ?1",
                &[&canvas_id]
            ),
            2
        );

        // 自连与跨画布拒绝。
        assert!(crate::db::canvas::connect(&conn, canvas_id, text_id, text_id).is_err());
        let other_canvas = unnamed["id"].as_str().unwrap();
        assert!(crate::db::canvas::connect(&conn, other_canvas, text_id, image_id).is_err());

        // 聚合视图。
        let list = crate::db::canvas::list_canvases(&conn).unwrap();
        assert_eq!(list.len(), 2);
        let mine = list.iter().find(|c| c["id"] == canvas["id"]).unwrap();
        assert_eq!(mine["node_count"], 4);
        assert_eq!(mine["connection_count"], 2);

        // 图谱加载。
        let graph = crate::db::canvas::get_canvas_graph(&conn, canvas_id).unwrap();
        assert_eq!(graph["canvas"]["name"], "改名后");
        assert_eq!(graph["nodes"].as_array().unwrap().len(), 4);
        assert_eq!(graph["connections"].as_array().unwrap().len(), 2);

        // 摘线换目标：改写 to_node。
        let rewired = crate::db::canvas::rewire(&conn, w1["id"].as_str().unwrap(), note_id).unwrap();
        assert_eq!(rewired["to_node"], note_id);

        // 换到已有同源连线的目标 = 合并：本线删除，返回既有行。
        let again = crate::db::canvas::rewire(&conn, rewired["id"].as_str().unwrap(), image_id).unwrap();
        assert_eq!(again["id"], w1["id"]);
        assert_eq!(
            count_params(
                &conn,
                "SELECT COUNT(*) FROM canvas_connections WHERE canvas_id = ?1",
                &[&canvas_id]
            ),
            2
        );

        // 布局批量落盘。
        crate::db::canvas::save_layout(
            &conn,
            canvas_id,
            &[serde_json::json!({ "id": text_id, "pos_x": 111.0, "pos_y": 222.0 })],
        )
        .unwrap();
        let (x, y): (f64, f64) = conn
            .query_row(
                "SELECT pos_x, pos_y FROM canvas_nodes WHERE id = ?1",
                params![text_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!((x, y), (111.0, 222.0));

        // 节点内容更新：标题与 metadata。
        let updated = crate::db::canvas::update_node(
            &conn,
            text_id,
            Some("新提示词".into()),
            Some(r#"{"kind":"text","content":"正文"}"#.into()),
            None,
        )
        .unwrap();
        assert_eq!(updated["title"], "新提示词");
        assert_eq!(updated["metadata"]["content"], "正文");
        // resource_path 更新并归一反斜杠。
        let repath = crate::db::canvas::update_node(
            &conn,
            text_id,
            None,
            None,
            Some("assets\\bar.png".into()),
        )
        .unwrap();
        assert_eq!(repath["resource_path"], "assets/bar.png");

        // 删节点级联清两端连线。
        crate::db::canvas::delete_node(&conn, ref_id).unwrap();
        assert_eq!(
            count_params(
                &conn,
                "SELECT COUNT(*) FROM canvas_connections WHERE canvas_id = ?1",
                &[&canvas_id]
            ),
            1
        );

        // 删画布级联清节点与连线（未命名画布无节点无连线）。
        crate::db::canvas::delete_canvas(&conn, canvas_id).unwrap();
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM canvas_nodes"), 0);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM canvas_connections"), 0);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM canvases"), 1);
    }

    #[test]
    fn viewport_and_layout_do_not_bump_updated_at() {
        let conn = canvas_conn();
        let canvas = crate::db::canvas::create_canvas(&conn, "布局不重排").unwrap();
        let canvas_id = canvas["id"].as_str().unwrap();
        let node = crate::db::canvas::create_node(
            &conn, canvas_id, "text", "", 0.0, 0.0, None, None, "", "",
        )
        .unwrap();
        let before: String = conn
            .query_row(
                "SELECT updated_at FROM canvases WHERE id = ?1",
                params![canvas_id],
                |row| row.get(0),
            )
            .unwrap();

        crate::db::canvas::set_viewport(&conn, canvas_id, 12.0, 34.0, 1.5).unwrap();
        crate::db::canvas::save_layout(
            &conn,
            canvas_id,
            &[serde_json::json!({ "id": node["id"], "pos_x": 1.0, "pos_y": 2.0, "width": 300.0, "height": 200.0 })],
        )
        .unwrap();

        let after: String = conn
            .query_row(
                "SELECT updated_at FROM canvases WHERE id = ?1",
                params![canvas_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(before, after, "视口/布局落盘不应重排画布列表");
        let (vx, vy, vk): (f64, f64, f64) = conn
            .query_row(
                "SELECT viewport_x, viewport_y, viewport_k FROM canvases WHERE id = ?1",
                params![canvas_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!((vx, vy, vk), (12.0, 34.0, 1.5));
    }

    #[test]
    fn node_meta_serde_roundtrip() {
        // 四变体序列化 → 解析往返。
        let metas = vec![
            NodeMeta::Text { content: "你好".into() },
            NodeMeta::Note { content: "便签".into() },
            NodeMeta::Ref {},
            NodeMeta::Image {
                params: crate::db::canvas::ImageGenParams {
                    model: "gpt-image-1".into(),
                    size: "1024x1024".into(),
                    count: 2,
                },
                status: crate::db::canvas::ImageNodeStatus::Generating,
                error: String::new(),
                images: vec![crate::db::canvas::GeneratedImage {
                    width: 1024,
                    height: 1024,
                    bytes: 2048,
                    resource_path: "画布产物/a.png".into(),
                    primary: true,
                }],
            },
        ];
        for meta in metas {
            let raw = serde_json::to_string(&meta).unwrap();
            let back = serde_json::from_str::<NodeMeta>(&raw).unwrap();
            assert_eq!(back, meta);
        }
    }

    #[test]
    fn node_meta_lenient_read_paths() {
        // 缺字段补默认（Image JSON 只有 kind）。
        let meta = parse_node_meta_lenient("image", r#"{"kind":"image"}"#);
        match meta {
            NodeMeta::Image { status, images, .. } => {
                assert_eq!(status, crate::db::canvas::ImageNodeStatus::Idle);
                assert!(images.is_empty());
            }
            _ => panic!("应为 Image 变体"),
        }
        // kind 与类型列不符 → 回退类型默认值，不阻断加载。
        let meta = parse_node_meta_lenient("text", r#"{"kind":"note","content":"x"}"#);
        assert_eq!(meta, NodeMeta::Text { content: String::new() });
        // 损坏 JSON → 回退默认。
        let meta = parse_node_meta_lenient("note", "not-json");
        assert_eq!(meta, NodeMeta::Note { content: String::new() });
    }

    #[test]
    fn node_meta_strict_write_paths() {
        let conn = canvas_conn();
        let canvas = crate::db::canvas::create_canvas(&conn, "t").unwrap();
        let canvas_id = canvas["id"].as_str().unwrap();
        // 未知节点类型拒绝。
        assert!(crate::db::canvas::create_node(
            &conn, canvas_id, "video", "", 0.0, 0.0, None, None, "", ""
        )
        .is_err());
        // metadata kind 与类型列不符拒绝落库。
        let raw = r#"{"kind":"image","params":{},"status":"idle","error":"","images":[]}"#;
        assert!(crate::db::canvas::create_node(
            &conn, canvas_id, "text", "", 0.0, 0.0, None, None, "", raw
        )
        .is_err());
        // 合法 metadata 落库后原样返回。
        let node = crate::db::canvas::create_node(
            &conn,
            canvas_id,
            "text",
            "",
            0.0,
            0.0,
            None,
            None,
            "",
            r#"{"kind":"text","content":"a"}"#,
        )
        .unwrap();
        assert_eq!(node["metadata"]["content"], "a");
    }
}
