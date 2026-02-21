module counter #(
  parameter int WIDTH = 8
) (
  input  logic             clk,
  input  logic             rst,
  output logic [WIDTH-1:0]  q
);

  always_ff @(posedge clk) begin
    if (rst) q <= '0;
    else     q <= q + 1'b1;
  end

endmodule
