const XLSX = require("xlsx");
const { HEADER_ALIASES } = require("./constants");
const { badRequestResponse, okResponse } = require("../../../constants/responses");

// ============================================================
// VALIDATE BULK UPLOAD FILE
// ============================================================

const validateBulkUploadFile = async (req, res, next) => {
  try {
    if (!req.file) {
      const response = badRequestResponse(
        "No file uploaded. Attach an .xlsx file under the 'file' field.",
      );
      return res.status(response.status.code).json(response);
    }

    let workbook;
    try {
      workbook = XLSX.read(req.file.buffer, { type: "buffer" });
    } catch (parseError) {
      const response = badRequestResponse(
        "Couldn't read that file as an .xlsx/.xls workbook.",
      );
      return res.status(response.status.code).json(response);
    }

    const sheetsReport = [];
    let anyValidRows = false;

    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json(sheet, {
        header: 1,
        raw: false,
        defval: "",
      });

      const headerRowIndex = rows.findIndex((r) =>
        r.some((cell) => String(cell).trim().toLowerCase() === "employee id"),
      );

      if (headerRowIndex === -1) {
        sheetsReport.push({
          sheet: sheetName,
          headerFound: false,
          validRows: 0,
          warnings: ["No 'Employee ID' header found"],
        });
        continue;
      }

      const colIndex = {};
      rows[headerRowIndex].forEach((cell, i) => {
        const key = HEADER_ALIASES[String(cell).trim().toLowerCase()];
        if (key) colIndex[key] = i;
      });

      const get = (raw, key) =>
        colIndex[key] !== undefined
          ? String(raw[colIndex[key]] ?? "").trim()
          : "";

      const dataRows = rows.slice(headerRowIndex + 1);
      let validRows = 0;
      for (const raw of dataRows) {
        const employeeCode = get(raw, "employeeCode");
        if (employeeCode && /^\d+$/.test(employeeCode)) validRows++;
      }
      if (validRows > 0) anyValidRows = true;

      const mappedFields = Object.entries(colIndex)
        .filter(([key]) => key !== "employeeCode")
        .map(([key]) => key);

      const warnings = [];
      if (validRows === 0) warnings.push("No valid data rows found");
      if (!colIndex.name) warnings.push("Missing 'User Name' column");
      if (!colIndex.shiftTiming)
        warnings.push("Missing 'Shift Timings' column");

      sheetsReport.push({
        sheet: sheetName,
        headerFound: true,
        validRows,
        mappedFields,
        warnings,
      });
    }

    const result = {
      canProceed: anyValidRows,
      sheets: sheetsReport,
    };

    const response = okResponse(result, "Workbook format checked.");
    return res.status(response.status.code).json(response);
  } catch (error) {
    next(error);
  }
};

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  validateBulkUploadFile,
};