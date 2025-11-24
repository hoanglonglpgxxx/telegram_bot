## EXPENSE MANAGER BOT

- cài qpdf scan lỗi file pdf
  "C:\Program Files\qpdf\bin\qpdf.exe" --check file-loi.pdf

- Nên xử lý chỗ category là nhập tên / chọn tên đã có

là mình sẽ làm 1 tiến trình nodejs mới, cho nó khởi lại các session Zalo, chia làm nhiều worker để tránh quá tải, mỗi worker giữ phiên cho < 100 tài khoản Zalo

cái nodejs mới sẽ làm cầu nối, Web gọi API => PHP => Nodejs => Zalo => NodeJs => PHP => Web

test